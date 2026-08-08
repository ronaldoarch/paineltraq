# Postbacks da Plataforma

A plataforma envia um POST **por evento**, com payload plano e **sem campo de tipo** —
o evento é identificado pela URL. Por isso existe um endpoint dedicado para cada um.

Base: `https://SEU_DOMINIO/postback`
Listagem das URLs em tempo real: `GET https://SEU_DOMINIO/postback`

## URLs a configurar no painel da plataforma

| Evento na plataforma    | URL a colar                        | Evento no Meta                |
|-------------------------|------------------------------------|-------------------------------|
| Cadastro de Usuários    | `/postback/cadastro`               | `CompleteRegistration`        |
| Depósito Gerado         | `/postback/deposito-gerado`        | `InitiateCheckout`            |
| Primeiro Depósito Pago  | `/postback/primeiro-deposito-pago` | `FirstDeposit` (custom, sem value) |
| Depósito Pago           | `/postback/deposito-pago`          | `Purchase`                    |
| Saque Solicitado        | `/postback/saque-solicitado`       | `WithdrawalRequested` (custom) |
| Saque Pago              | `/postback/saque-pago`             | `WithdrawalPaid` (custom)     |

Aliases em inglês também funcionam: `/register`, `/deposit-created`, `/first-deposit`
(ou `/ftd`), `/deposit-paid`, `/withdrawal-requested`, `/withdrawal-paid`.

> **Configure os dois eventos de depósito.** A receita (`Purchase`) só é contada em
> **Depósito Pago**. `FirstDeposit` vai à CAPI **sem value**, apenas para segmentação —
> se você configurar somente "Primeiro Depósito Pago", o primeiro depósito não gera receita
> no Meta.

## Payloads aceitos

Exatamente os da documentação da plataforma:

```jsonc
// Cadastro de Usuários
{"name": "", "firstname": "", "phone": "", "email": "", "cpf": "", "gender": "", "birthday": ""}

// Depósito Gerado / Primeiro Depósito Pago / Depósito Pago
{"phone": "", "email": "", "value": "", "pix_code": ""}

// Saque Solicitado / Saque Pago
{"phone": "", "email": "", "value": ""}
```

Campos opcionais reconhecidos se a plataforma for configurada para enviá-los:
`user_id`, `fbc`, `fbp`, `click_id`/`fbclid`, `ip`, `user_agent`, `utm_*`, `currency`, `country`.

### Normalizações aplicadas

| Campo      | Entrada aceita                                   | Guardado como           |
|------------|--------------------------------------------------|-------------------------|
| `phone`    | `(16) 99999-8888`, `16999998888`                 | E.164 → `5516999998888` |
| `email`    | qualquer caixa, com espaços                      | minúsculas, sem espaços |
| `cpf`      | `123.456.789-00`                                 | `12345678900`           |
| `gender`   | `masculino`/`feminino`/`male`/`female`/`m`/`f`   | `m` / `f` (CAPI `ge`)   |
| `birthday` | `15/03/1990`, `1990-03-15`, ISO 8601             | `19900315` (CAPI `db`)  |
| `value`    | `150.50`, `"150,50"`, `"R$ 1.234,56"`            | número decimal          |

CPF, gênero e nascimento melhoram o *Advanced Matching*: vão hashados (SHA-256) como
`external_id`, `ge` e `db`.

## Correlação de usuários

Cada postback é ligado ao jogador nesta ordem: `click_id` → `fbc` → `external_id` →
**`cpf`** → `email` → `phone`. Como só o Cadastro traz CPF, os depósitos e saques
normalmente casam por e-mail ou telefone e enriquecem o registro existente.

Um postback **sem `email`, `phone` e `cpf`** é respondido com `200` e
`{"processed": false, "reason": "missing_identifier"}` — sem identificador não há como
correlacionar o jogador.

## Deduplicação

- **Cadastro:** chave é a identidade do jogador (CPF/e-mail/telefone) — reenvios não duplicam.
- **Depósitos:** chave é o `pix_code`. O mesmo PIX em "Gerado", "Primeiro Pago" e "Pago"
  gera três eventos distintos (um por tipo), mas cada um só uma vez.
- **Saques e depósitos sem `pix_code`:** não há identificador, então a chave é
  identidade + valor dentro de uma janela de **5 minutos**. Reenvios da plataforma são
  absorvidos; dois saques idênticos do mesmo jogador dentro de 5 minutos contam como um.

## Segurança (opcional)

Por padrão os endpoints ficam abertos, porque a maioria dos painéis só permite configurar
a URL. Para exigir autenticação, defina `WEBHOOK_SECRET_POSTBACK` (ou a chave
`webhook_secret_postback` em `settings`). Com o secret ativo, qualquer uma destas formas serve:

```
X-Webhook-Secret: <secret>
Authorization: Bearer <secret>
https://SEU_DOMINIO/postback/deposito-pago?secret=<secret>
```

## Teste rápido

```bash
curl -X POST https://SEU_DOMINIO/postback/deposito-pago \
  -H 'Content-Type: application/json' \
  -d '{"phone":"(16) 99999-8888","email":"jogador@example.com","value":"150,50","pix_code":"PIX-TESTE-1"}'
```

Resposta esperada:

```json
{"received":true,"processed":true,"event":"Depósito Pago","success":true,
 "duplicate":false,"eventId":"...","metaEventName":"Purchase"}
```

Depois confira em **Eventos** no painel (filtro *Fonte: Postback*). URL errada devolve
`404` com a lista de endpoints válidos.
