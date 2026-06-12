# AI Clarification Fallback

When OpenAI NLU is unavailable and the local parser cannot understand the message,
the API no longer returns HTTP 500.

It returns:

```json
{
  "intent": "NEED_CLARIFICATION",
  "message": "Món bon là bao nhiêu kg?"
}
```

This prevents app crashes and allows the UI/voice POS to ask the user again.
