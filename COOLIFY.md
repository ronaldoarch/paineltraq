# Deploy no Coolify — Bearbet Tracker

Este projeto está preparado para o [Coolify](https://coolify.io): **Dockerfile** com entrypoint (migrações + start), **`coolify-compose.yml`** com app + PostgreSQL + Redis (sem Nginx/Certbot; SSL e proxy ficam no Coolify), **`TRUST_PROXY`** para IP real atrás do proxy, e **`package-lock.json`** para build reproduzível com `npm ci`.

## Opção A — Docker Compose (recomendado)

1. No Coolify, crie um recurso **Docker Compose** apontando para este repositório.
2. Defina o caminho do arquivo de compose: **`coolify-compose.yml`** (ou renomeie no Coolify se a UI pedir outro nome).
3. Na seção de **variáveis de ambiente** do projeto (ou do compose), configure no mínimo:

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `DB_PASSWORD` | Sim | Senha do PostgreSQL (compose repassa para `app` e `postgres`). |
| `JWT_SECRET` | Sim | Chave forte para JWT do painel. |
| `BASE_URL` | Sim | URL pública com `https://` (ex.: `https://track.seudominio.com`), usada no CORS em produção. |
| `RUN_SEED` | Só no 1º deploy | Defina `true` **uma vez** para criar o admin (`admin` / senha inicial do seed) e gravar `settings` a partir de `META_*`. Depois volte para `false` ou remova, para não sobrescrever settings com env vazio. |
| `META_PIXEL_ID` | Com `RUN_SEED` | Opcional no seed; pode configurar depois no painel. |
| `META_ACCESS_TOKEN` | Com `RUN_SEED` | Idem. |
| `META_API_VERSION` | Não | Padrão `v19.0`. |
| `META_TEST_EVENT_CODE` | Não | Testes no Gerenciador de eventos da Meta. |
| `DEBUG_MODE` | Não | `false` em produção. |
| `DB_NAME` | Não | Padrão `bearbet_tracker`. |
| `DB_USER` | Não | Padrão `bearbet`. |

4. **Porta do serviço `app`:** o compose expõe **3000** e define `PORT=3000`. No Coolify, marque a porta publicada **3000** (ou ajuste compose e `PORT` de forma consistente).
5. **Domínio:** associe o FQDN ao serviço `app`; o Coolify termina o SSL (Let’s Encrypt).
6. Faça o deploy. No primeiro deploy, use `RUN_SEED=true`, acesse o painel, **troque a senha do admin** e, se necessário, ajuste Meta nas configurações.

### Health check

- Caminho: **`/api/health`** (público, testa PostgreSQL).
- Opcional: configure o health check HTTP do Coolify para essa URL na porta interna do container (`PORT`, normalmente **3000** neste compose).

## Opção B — Só Dockerfile + bancos gerenciados no Coolify

1. Crie **PostgreSQL** e **Redis** como serviços no Coolify e anote os **hosts internos** e portas.
2. Crie um recurso **Dockerfile** (build context na raiz, Dockerfile padrão).
3. Variáveis de ambiente da aplicação:

| Variável | Valor típico |
|----------|----------------|
| `PORT` | O que o Coolify injetar (ex.: `3000`). |
| `TRUST_PROXY` | `true` |
| `DB_HOST` | Host interno do Postgres (Coolify). |
| `DB_PORT` | `5432` |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Conforme o banco criado. |
| `REDIS_HOST` | Host interno do Redis. |
| `REDIS_PORT` | `6379` |
| `JWT_SECRET`, `BASE_URL`, `META_*` | Igual à opção A. |

4. **Primeiro start:** nas variáveis de ambiente do container, defina **`RUN_SEED=true`** só no primeiro deploy (ou rode `npm run seed` no console/exec do Coolify com o mesmo `.env`). Migrações rodam automaticamente no entrypoint (`SKIP_MIGRATIONS=true` pula, se precisar em debug).

## Variáveis úteis do container

| Variável | Descrição |
|----------|-----------|
| `SKIP_MIGRATIONS` | `true` — não executa `migrations/run.js` antes do Node (só emergência). |
| `RUN_SEED` | `true` — executa `migrations/seed.js` após migrações (cuidado em produção). |

## Webhooks na Meta / parceiros

Cadastre URLs públicas **HTTPS** do Coolify, por exemplo:

- `https://track.seudominio.com/webhook/xgate`
- `https://track.seudominio.com/webhook/cassino`
- `https://track.seudominio.com/webhook/fluxlab`

## Problemas comuns no Coolify

### **504 Gateway Timeout** / Traefik na porta errada

Se o app ouve em **3001** (stack com `docker-compose.yml`) ou **3000** (`coolify-compose.yml`), o Traefik **não** pode assumir a porta **80** do container.

1. **No compose do repositório** já estão as variáveis mágicas `SERVICE_URL_APP_3001` / `SERVICE_FQDN_APP_3001` (stack com Nginx) e `SERVICE_URL_APP_3000` (`coolify-compose.yml`), para o Coolify gerar o proxy para a porta certa — ver [Docker Compose no Coolify](https://coolify.io/docs/knowledge-base/docker/compose#domains) e [variáveis mágicas](https://coolify.io/docs/knowledge-base/environment-variables#magic-environment-variables-docker-compose).
2. **Alternativa na UI:** no domínio do serviço `app`, usar `https://seu-fqdn:3001` (a `:3001` indica ao Coolify **só** a porta interna; o site público continua em HTTPS normal). Idem **`:80`** para o **nginx**, se necessário.

### `address already in use` (portas **80**, **8080**, **3001**, etc.)

No Coolify as portas **80** e **8080** do host costumam estar com o **Traefik** ou outras stacks. O `docker-compose.yml` **não publica** portas no host para `app`, `nginx`, `postgres` nem `redis` — só **`expose`** na rede interna; o proxy do Coolify encaminha para o serviço (ex.: **nginx**, porta de container **80**).

Na UI do recurso (**Domínios** / **Portas**), associe o domínio ao serviço **nginx** na porta **80** do *container* (não confundir com publicação no host). O compose inclui `SERVICE_URL_NGINX_80` para alinhar o Traefik ao **nginx** na **80**.

### Erro ao montar **`nginx.conf`** (“directory onto a file” / `not a directory`)

O Coolify grava dados em `/data/coolify/applications/.../`. Bind-mount de **arquivo** (`./nginx/nginx.conf`) nesse ambiente às vezes vira diretório e o Nginx não sobe.

**Correção no repositório:** o serviço **nginx** passa a ser **build** a partir de `nginx/Dockerfile`, que copia `nginx.conf` **para dentro da imagem** — não há mais mount do arquivo no host.

### Migrações com `ECONNREFUSED 127.0.0.1:5432`

O app estava a usar **`DB_HOST=localhost`** (valor comum no `.env` gerado pelo Coolify). Dentro do container o Postgres é o serviço **`postgres`**, não o localhost.

O `docker-compose.yml` força **`DB_HOST=postgres`** e **`REDIS_HOST=redis`** no serviço `app`, e o entrypoint **espera** o Postgres antes das migrações.

### `Bind for 0.0.0.0:8080 failed: port is already allocated`

Outro recurso no mesmo servidor pode estar a usar **8080** no host. O compose **já não mapeia** Nginx nem app para o host; se ainda vir este erro, confirme que o deploy usa o **`docker-compose.yml` atual** do Git e remova containers antigos do mesmo projeto no servidor.

### Preferir sem Nginx no Coolify

Use o arquivo **`coolify-compose.yml`**: só app + Postgres + Redis, **sem** Nginx/Certbot, com SSL só na UI do Coolify (recomendado se quiser evitar Nginx dentro do stack).

## Stack local original (Nginx + Certbot)

Para VPS sem Coolify, continue usando **`docker-compose.yml`** e o guia **[DEPLOY.md](./DEPLOY.md)**.

Na **VPS** (sem Coolify), use **`docker-compose.vps.yml`** junto com o principal — ver **[DEPLOY.md](./DEPLOY.md)** (`COMPOSE_FILE=docker-compose.yml:docker-compose.vps.yml`).
