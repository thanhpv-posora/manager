# OpenAI DNS / Timeout Fix

This build adds:

```js
require('dns').setDefaultResultOrder('ipv4first');
```

in `src/server.js`.

It helps Node.js connect to `api.openai.com` when IPv6/DNS resolution causes `UND_ERR_CONNECT_TIMEOUT`.

Recommended `.env`:

```env
OPENAI_API_KEY=your_new_key_here
OPENAI_NLU_MODEL=gpt-4o-mini
OPENAI_NLU_TIMEOUT_MS=15000
```

Important: if an API key was pasted into chat/logs, revoke it and create a new one.
