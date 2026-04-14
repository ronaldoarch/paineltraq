# 🎯 Bearbet Tracker

Sistema de tracking server-side para envio de eventos ao Meta Ads via Conversion API (CAPI).

## Arquitetura

```
Usuário clica no anúncio
     ↓
Captura fbc/fbp/click_id
     ↓
Cadastro → Webhook Cassino → [Bearbet Tracker]
     ↓                              ↓
Depósito                      Correlaciona usuário
     ↓                              ↓
XGate processa PIX            Enfileira evento
     ↓                              ↓
Webhook XGate ──────────────→ Envia via CAPI
                                     ↓
                              Meta Ads recebe ✓
```

## Stack

- **Backend:** Node.js + Express
- **Banco de Dados:** PostgreSQL 16
- **Fila:** Redis + Bull
- **Proxy:** Nginx
- **Containers:** Docker Compose

## Estrutura do Projeto

```
bearbet-tracker/
├── src/
│   ├── config/         # Configurações (DB, Redis, Logger)
│   ├── middleware/      # Auth JWT, Webhook Logger
│   ├── routes/          # Endpoints (webhooks + API)
│   ├── services/        # Lógica de negócio
│   ├── jobs/            # Workers da fila
│   ├── utils/           # Helpers (hash, normalização)
│   └── server.js        # Entry point
├── migrations/          # Scripts de banco de dados
├── public/              # Dashboard (frontend)
├── nginx/               # Nginx (Dockerfile + nginx.conf)
├── docker-compose.yml   # Orquestração (VPS + Nginx + Certbot)
├── coolify-compose.yml  # Stack para Coolify (app + Postgres + Redis)
├── Dockerfile           # Build da aplicação
├── scripts/
│   └── docker-entrypoint.sh  # Migrações + start (Docker / Coolify)
├── DEPLOY.md            # Guia de deploy (VPS manual)
├── COOLIFY.md           # Guia de deploy no Coolify
└── .env.example         # Template de configuração
```

## Eventos Suportados

| Evento Interno               | Nome Meta              |
|-------------------------------|------------------------|
| user.register                 | CompleteRegistration    |
| payment.deposit.started       | InitiateCheckout       |
| payment.deposit.completed     | Purchase               |

## Endpoints

### Webhooks (sem autenticação)
- `POST /webhook/xgate` — Eventos da processadora de pagamento
- `POST /webhook/cassino` — Eventos do backoffice do cassino
- `POST /webhook/fluxlab` — Eventos do FluxLab

### API (autenticação JWT)
- `POST /api/auth/login` — Login
- `GET /api/stats` — Estatísticas do dashboard
- `GET /api/events` — Lista de eventos
- `GET /api/users` — Lista de usuários
- `GET /api/settings` — Configurações
- `GET /api/health` — Health check

## Deploy

- **VPS com Docker Compose (Nginx + SSL):** [DEPLOY.md](./DEPLOY.md)
- **Coolify (recomendado para homologação/produção gerenciada):** [COOLIFY.md](./COOLIFY.md)

## Licença

Proprietário — Bearbet © 2024
