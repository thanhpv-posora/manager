# Architecture Overview

Current stack:

- Frontend: React 18 + Vite
- Backend: Node.js + Express
- Database: MySQL 8
- Deployment: Docker Compose
- AI: OpenAI NLU + deterministic parsers + OCR + AI skills

Current dominant pattern:

```text
Route → Agent → Service → Database
```

Target V70 direction:

```text
Route → Agent/Application Service → Domain Service → Repository → Database
```

Business logic must not leak into frontend or route handlers.
