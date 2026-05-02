import asyncio
import json
import os
import sys

from notebooklm import NotebookLMClient


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
        if not os.environ.get("NOTEBOOKLM_AUTH_JSON"):
            raise ValueError("NOTEBOOKLM_AUTH_JSON is not configured")

        async with await NotebookLMClient.from_storage(timeout=timeout) as client:
            result = await asyncio.wait_for(client.chat.ask(notebook_id, message), timeout=timeout)

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
