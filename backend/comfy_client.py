"""Async client for the hidden ComfyUI backend (HTTP + WebSocket).

Only this module talks to ComfyUI. The rest of the app speaks to it through here.
Uses aiohttp (already a ComfyUI dependency), so no extra runtime deps are required.
"""
import asyncio
import json
import struct
import uuid

import aiohttp

# ComfyUI binary websocket event ids
_EVENT_PREVIEW_IMAGE = 1


class ComfyClient:
    def __init__(self, host="127.0.0.1", port=8199):
        self.host = host
        self.port = port
        self.base = f"http://{host}:{port}"
        self.ws_base = f"ws://{host}:{port}"
        self.client_id = uuid.uuid4().hex

    async def system_stats(self, session):
        async with session.get(f"{self.base}/system_stats") as r:
            r.raise_for_status()
            return await r.json()

    async def wait_until_ready(self, timeout=300, interval=1.0):
        """Poll /system_stats until ComfyUI answers or timeout (seconds) elapses."""
        deadline = asyncio.get_event_loop().time() + timeout
        async with aiohttp.ClientSession() as session:
            while asyncio.get_event_loop().time() < deadline:
                try:
                    await self.system_stats(session)
                    return True
                except Exception:
                    await asyncio.sleep(interval)
        return False

    async def upload_image(self, session, data: bytes, filename: str,
                           subfolder="whatdreamscost", overwrite=True):
        form = aiohttp.FormData()
        form.add_field("image", data, filename=filename, content_type="application/octet-stream")
        form.add_field("subfolder", subfolder)
        form.add_field("type", "input")
        form.add_field("overwrite", "true" if overwrite else "false")
        async with session.post(f"{self.base}/upload/image", data=form) as r:
            r.raise_for_status()
            return await r.json()  # {name, subfolder, type}

    async def queue_prompt(self, session, prompt: dict):
        payload = {"prompt": prompt, "client_id": self.client_id}
        async with session.post(f"{self.base}/prompt", json=payload) as r:
            body = await r.json()
            if r.status != 200:
                raise RuntimeError(f"ComfyUI /prompt error: {json.dumps(body)}")
            return body["prompt_id"]

    async def interrupt(self, session):
        async with session.post(f"{self.base}/interrupt") as r:
            return r.status == 200

    async def free(self, session, unload_models=True, free_memory=True):
        """Ask ComfyUI to release loaded models from VRAM + RAM.

        ComfyUI keeps model weights resident after a run to speed up repeats. On
        low-VRAM machines that permanent allocation is a problem, so we call this
        when a generation ends. The worker processes these flags between prompts:
        `unload_models` -> unload_all_models(), `free_memory` -> free cache + gc.
        """
        payload = {"unload_models": unload_models, "free_memory": free_memory}
        async with session.post(f"{self.base}/free", json=payload) as r:
            return r.status == 200

    async def get_history(self, session, prompt_id):
        async with session.get(f"{self.base}/history/{prompt_id}") as r:
            r.raise_for_status()
            data = await r.json()
            return data.get(prompt_id)

    def view_url(self, filename, subfolder="", type_="output"):
        from urllib.parse import urlencode
        q = urlencode({"filename": filename, "subfolder": subfolder, "type": type_})
        return f"{self.base}/view?{q}"

    async def fetch_view(self, session, filename, subfolder="", type_="output"):
        async with session.get(self.view_url(filename, subfolder, type_)) as r:
            r.raise_for_status()
            return await r.read(), r.headers.get("Content-Type", "application/octet-stream")

    async def listen(self, queue: asyncio.Queue):
        """Connect to ComfyUI /ws and push events onto `queue`.

        Pushes dicts:
            {"kind": "event", "data": <comfy json message>}
            {"kind": "preview", "data": <jpeg/png bytes>}
        Runs until the socket closes.
        """
        url = f"{self.ws_base}/ws?clientId={self.client_id}"
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(url, heartbeat=30, max_msg_size=0) as ws:
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        try:
                            await queue.put({"kind": "event", "data": json.loads(msg.data)})
                        except json.JSONDecodeError:
                            pass
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        payload = msg.data
                        if len(payload) >= 8:
                            event = struct.unpack(">I", payload[:4])[0]
                            if event == _EVENT_PREVIEW_IMAGE:
                                await queue.put({"kind": "preview", "data": payload[8:]})
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        break
