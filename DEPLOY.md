# 🚀 GUIA DE DEPLOY — Bearbet Tracker

## Passo a passo para colocar no ar (copie e cole!)

---

## 📋 PRÉ-REQUISITOS

Antes de começar, você precisa de:

1. **Uma VPS** (servidor) — recomendo DigitalOcean, Hetzner ou Contabo
   - Mínimo: 1 vCPU, 2GB RAM, 25GB SSD
   - Sistema: Ubuntu 22.04 ou 24.04
   - Custo: $5 a $12/mês

2. **Um domínio** (ou subdomínio) apontando para o IP da VPS
   - Exemplo: `track.bearbet.com`

3. **Acesso SSH** ao servidor (você recebe quando contrata a VPS)

---

## 🔌 PASSO 1 — Acessar o servidor

No Windows, use o **PowerShell** ou **PuTTY**.
No Mac/Linux, use o **Terminal**.

```bash
ssh root@SEU_IP_DO_SERVIDOR
```

Digite a senha que recebeu da VPS e aperte Enter.

---

## 📦 PASSO 2 — Instalar Docker

Cole TODOS esses comandos, um por um:

```bash
# Atualizar sistema
apt update && apt upgrade -y

# Instalar Docker
curl -fsSL https://get.docker.com | sh

# Instalar Docker Compose
apt install docker-compose-plugin -y

# Verificar instalação (deve mostrar a versão)
docker --version
docker compose version
```

✅ Se viu os números de versão, tudo certo!

---

## 📁 PASSO 3 — Enviar o projeto para o servidor

**Opção A — Via Git (recomendado):**

Se o projeto estiver no GitHub:
```bash
cd /opt
git clone https://github.com/SEU_USUARIO/bearbet-tracker.git
cd bearbet-tracker
```

**Opção B — Via upload direto:**

No seu computador, use o comando:
```bash
scp -r ./bearbet-tracker root@SEU_IP:/opt/bearbet-tracker
```

Depois, no servidor:
```bash
cd /opt/bearbet-tracker
```

---

## ⚙️ PASSO 4 — Configurar variáveis de ambiente

```bash
# Copiar o arquivo de exemplo
cp .env.example .env

# Editar as configurações
nano .env
```

No editor, altere os seguintes campos:

```
DB_PASSWORD=COLOQUE_UMA_SENHA_FORTE_AQUI
JWT_SECRET=COLOQUE_OUTRA_SENHA_DIFERENTE_AQUI
META_PIXEL_ID=SEU_PIXEL_ID_DO_FACEBOOK
META_ACCESS_TOKEN=SEU_TOKEN_DA_CAPI
```

Para salvar e sair do nano:
1. Aperte `Ctrl + X`
2. Aperte `Y` (para confirmar)
3. Aperte `Enter`

---

## 🐳 PASSO 5 — Subir o projeto

```bash
# Construir e iniciar todos os containers
docker compose up -d --build
```

⏳ Aguarde 1-2 minutos na primeira vez.

Para ver se está tudo rodando:
```bash
docker compose ps
```

✅ Deve mostrar 4 containers (app, postgres, redis, nginx) com status "Up"

---

## 🗃️ PASSO 6 — Criar tabelas do banco de dados

```bash
# Executar migrações
docker compose exec app node migrations/run.js

# Criar usuário admin
docker compose exec app node migrations/seed.js
```

✅ Deve mostrar vários "✅" na tela

---

## 🔒 PASSO 7 — Configurar SSL (HTTPS)

```bash
# Gerar certificado SSL gratuito (Let's Encrypt)
docker compose run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  -d track.bearbet.com \
  --email seuemail@exemplo.com \
  --agree-tos \
  --no-eff-email
```

**IMPORTANTE:** Substitua `track.bearbet.com` pelo seu domínio real.

Depois de gerar o certificado, edite o nginx:
```bash
nano nginx/nginx.conf
```

Descomente o bloco `HTTPS` (remova os `#` do bloco do server 443) e comente/remova as linhas do bloco HTTP que fazem proxy (deixe apenas o redirect).

Reinicie o nginx:
```bash
docker compose restart nginx
```

---

## ✅ PASSO 8 — Testar

Abra no navegador (tráfego passa pelo **Nginx** na porta **80**):
```
http://SEU_IP/api/health
```

Ou se já configurou domínio e SSL:
```
https://track.bearbet.com/api/health
```

Deve retornar algo como:
```json
{
  "status": "healthy",
  "database": "connected"
}
```

---

## 🔐 PASSO 9 — Primeiro login no Dashboard

Acesse: `https://track.bearbet.com` (ou seu domínio)

```
Usuário: admin
Senha: bearbet2024
```

⚠️ **TROQUE A SENHA IMEDIATAMENTE** após o primeiro login!

---

## 🔗 PASSO 10 — Configurar Webhooks

No dashboard, vá em **Configurações** e copie as URLs:

### XGate
Cole esta URL no painel de webhooks da XGate:
```
https://track.bearbet.com/webhook/xgate
```

### Cassino (Backoffice)
Se o cassino tem opção de webhook, use:
```
https://track.bearbet.com/webhook/cassino
```

### FluxLab
Configure no FluxLab para enviar para:
```
https://track.bearbet.com/webhook/fluxlab
```

---

## 🔧 COMANDOS ÚTEIS (guarde esses!)

```bash
# Ver logs em tempo real
docker compose logs -f app

# Ver logs só de erros
docker compose logs -f app | grep -i error

# Reiniciar tudo
docker compose restart

# Parar tudo
docker compose down

# Subir tudo de novo
docker compose up -d

# Atualizar o código (se mudou algo)
docker compose up -d --build

# Ver status dos containers
docker compose ps

# Acessar o banco de dados diretamente
docker compose exec postgres psql -U bearbet -d bearbet_tracker

# Ver uso de disco
docker system df
```

---

## 🔄 ATUALIZAÇÕES FUTURAS

Quando precisar atualizar o sistema:

```bash
cd /opt/bearbet-tracker

# Se estiver usando Git
git pull

# Reconstruir e reiniciar
docker compose up -d --build
```

---

## ❓ PROBLEMAS COMUNS

### "Connection refused" ao acessar
→ Verifique se o firewall está liberando as portas 80 e 443:
```bash
ufw allow 80
ufw allow 443
```

O app Node escuta só na rede Docker na **3001**; não é necessário liberar **3001** no firewall, a menos que você use um `docker-compose.override.yml` para publicar essa porta no host.

### Container postgres não sobe
→ Verifique a senha no .env — ela não pode ter caracteres especiais como `$` ou `!`

### Webhook não chega
→ Verifique os logs:
```bash
docker compose logs -f app | grep webhook
```

### Erro de certificado SSL
→ Verifique se o domínio aponta para o IP correto:
```bash
dig track.bearbet.com
```

---

## 📊 MONITORAMENTO

Para configurar um health check externo gratuito:
1. Acesse https://uptimerobot.com
2. Crie uma conta gratuita
3. Adicione um monitor HTTP apontando para:
   `https://track.bearbet.com/api/health`
4. Configure para verificar a cada 5 minutos

Isso te avisa por email se o sistema cair.

---

## 🎯 PRÓXIMOS PASSOS APÓS DEPLOY

1. ✅ Trocar senha do admin
2. ✅ Configurar Pixel ID e Access Token no dashboard
3. ✅ Testar conexão com o Meta (botão no dashboard)
4. ✅ Configurar webhooks na XGate e Cassino
5. ✅ Usar o Test Event Code do Meta para validar
6. ✅ Monitorar os primeiros eventos no dashboard
7. ✅ Remover o Test Event Code quando tudo estiver ok
