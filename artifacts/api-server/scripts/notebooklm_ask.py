import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from notebooklm import AuthTokens, NotebookLMClient
from notebooklm.auth import fetch_tokens, load_auth_from_storage


async def main() -> int:
    try:
        payload = json.load(sys.stdin)
        notebook_id = str(payload.get("notebook_id") or os.environ.get("NOTEBOOKLM_NOTEBOOK_ID") or "").strip()
        message = str(payload.get("message") or "").strip()
        timeout = float(payload.get("timeout_seconds") or os.environ.get("NOTEBOOKLM_CLIENT_TIMEOUT_SECONDS") or 420)

        if not notebook_id:
            raise ValueError("NOTEBOOKLM_NOTEBOOK_ID is not configured")
        if not message:
            raise ValueError("message is required")
        auth_json = os.environ.get("NOTEBOOKLM_AUTH_JSON")
        storage_path = os.environ.get("NOTEBOOKLM_STORAGE_PATH")
        temp_storage_path = None
        if auth_json:
            fd, temp_storage_path = tempfile.mkstemp(prefix="notebooklm-storage-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(auth_json)
            try:
                Path(temp_storage_path).chmod(0o600)
            except OSError:
                pass
            storage_path = temp_storage_path
        if not storage_path:
            raise ValueError("NOTEBOOKLM_AUTH_JSON or NOTEBOOKLM_STORAGE_PATH is required")

        try:
            cookies = load_auth_from_storage(Path(storage_path))
            csrf_token, session_id = await fetch_tokens(cookies)
            auth = AuthTokens(cookies=cookies, csrf_token=csrf_token, session_id=session_id)
            async with NotebookLMClient(auth, timeout=timeout) as client:
                result = await asyncio.wait_for(client.chat.ask(notebook_id, message), timeout=timeout)
        finally:
            if temp_storage_path:
                try:
                    os.remove(temp_storage_path)
                except OSError:
                    pass

        references = []
        for ref in getattr(result, "references", []) or []:
            references.append(
                {
                    "sourceId": getattr(ref, "source_id", None),
                    "citationNumber": getattr(ref, "citation_number", None),
                    "citedText": getattr(ref, "cited_text", None),
                    "startChar": getattr(ref, "start_char", None),
                    "endChar": getattr(ref, "end_char", None),
                    "chunkId": getattr(ref, "chunk_id", None),
                }
            )

        print(
            json.dumps(
                {
                    "answer": getattr(result, "answer", ""),
                    "conversationId": getattr(result, "conversation_id", None),
                    "turnNumber": getattr(result, "turn_number", None),
                    "isFollowUp": getattr(result, "is_follow_up", False),
                    "references": references,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
