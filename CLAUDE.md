# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MeatBiz V6.65 POS Agent** — A professional meat business Point-of-Sale system with AI agents, multi-user management, inventory tracking, order/payment management, and business analytics.

- Backend: Node.js/Express (`backend/`) on port 4000
- Frontend: React 18 + Vite (`frontend/`) on port 5173
- Database: MySQL 8 (auto-initialized on startup)

## Development Commands

### Backend
```bash
cd backend
npm run dev     # Development with nodemon (hot reload)
npm start       # Production
npm run check   # Startup verification check
```

### Frontend
```bash
cd frontend
npm run dev     # Vite dev server
npm run build   # Production build → dist/
npm run preview # Preview production build
```

Both backend and frontend must run simultaneously for full functionality.

### Health check
`GET /api/health` → `{ok:true, name:'meatbiz-api', version:'6.6.0'}`

## Architecture

### Request Flow
**Route → Agent → Service → Database**

- **Routes** (`backend/src/routes/`): Express handlers; 30 route groups registered in `server.js`
- **Agents** (`backend/src/agents/`): Business logic orchestrators; 29 classes that coordinate between services
- **Services** (`backend/src/services/`): Data access and domain-specific logic; 22 service modules
- **Skills** (`backend/src/skills/`): AI skill definitions used by the chat/AI system (NLU, Order, Payment, Inventory, Insight)

### Database Schema
`backend/src/config/bootstrap.js` defines 40+ tables and is auto-executed on startup by `AutoMigrationAgent`. Never manually create/drop tables — all schema changes go through bootstrap.js or `SchemaMigrationAgent`.

### Frontend Architecture
- **`App.jsx`**: Auth routing and page dispatcher
- **`layouts/MainLayout.jsx`**: Sidebar navigation with role-based menu
- **`api/api.js`**: Single Axios instance with JWT auto-injection and 45s timeout; all HTTP calls go through here
- **`pages/`**: 27 full-page components; `CreateOrder.jsx` is the main POS screen (complex, ~56KB)
- **`components/pos/`**: Three sub-agents split from CreateOrder — `POSHeaderAgent`, `POSProductTableAgent`, `POSPaymentPanelAgent`
- **`components/ai/`**: AI chat panel, business panel, and voice POS panel

### Authentication
JWT-based. Backend: `backend/src/middleware/auth.js`. Frontend stores token in localStorage; `api.js` injects it. Roles: `ADMIN`, `STAFF`, `CUSTOMER` — menus and permissions are per-user via `user_menu_permissions` table.

### AI System
Chat flows through `backend/src/routes/ai.routes.js` → `chat.service.js` → Skills (NLU parsing → domain skill execution). AI features include: conversational order creation, inventory prediction, payment suggestions, and handwritten bill OCR via Tesseract.js (frontend) or Google Document AI (backend).

### Key Utilities
- `backend/src/utils/lunar.js` + `lunarDate.js`: Lunar calendar — used throughout for Vietnamese date handling
- `frontend/src/utils/voiceBillParser.js`: Parses Web Speech API results into order data
- `frontend/src/utils/qtyExpression.js`: Parses quantity expressions like "2.5kg", "3 con"
- `frontend/src/utils/handwritingBillParser.js`: Parses OCR output into structured orders

## Environment Configuration

**Backend** (`.env`, see `.env.example`):
- `PORT` — default 4000
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `JWT_SECRET`
- `PUBLIC_APP_URL` — frontend URL (used in emails)
- `GOOGLE_APPLICATION_CREDENTIALS` — path to service account JSON for Document AI OCR
- Mail/SMTP settings for nodemailer

**Frontend** (`.env`):
- `VITE_API_URL` — backend API base URL

## Key Conventions

- Agent classes in `backend/src/agents/` are named `<Domain>Agent.js` and are the authoritative place for multi-step business logic. Keep routes thin.
- Services are stateless — instantiated per-request or once at module level; no mutable shared state.
- The `logs/` directory under `backend/` contains structured logs (system, errors, AI) — log files are date-stamped and managed by `fileLogger.service.js`.
- Bill printing supports two formats: A4 and thermal K80 — logic lives in `backend/src/services/PrintService.js`.
