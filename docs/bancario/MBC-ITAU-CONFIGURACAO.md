# Configuração Itaú (MBC) — procedimento operacional

Procedimento para autenticar o provider **ITAU** no Motor Bancário.  
Não inclui saldo, extrato, sincronização nem conciliação (escopo MBC-ITAU-02+).

**Nunca coloque Client Secret, certificado privado ou private key nesta documentação, em código-fonte, em tickets ou em prints.**

---

## 1. Onde configurar

1. ERP → **Contas bancárias**
2. Abrir a conta Itaú (ou criar/selecionar a conta desejada)
3. Aba / painel **Integração**
4. Provider: **Itaú** (`ITAU`)
5. Ambiente: **Sandbox**, **Homologação** ou **Produção**
6. Preencher credenciais no painel Itaú e **Salvar credenciais**
7. **Testar conexão**

API equivalente:

| Método | Rota |
|--------|------|
| GET/POST/DELETE | `/api/bancario/configuracoes/:id/credenciais` |
| POST | `/api/bancario/configuracoes/:id/conexao/testar` |

---

## 2. Credenciais necessárias

| Item | Onde fica | Observação |
|------|-----------|------------|
| Client ID | `aplicacao_ref` (visível no status) | Público na UI após salvar |
| Client Secret | SecretStore `mbc.config.{configId}` | Nunca retornado pela API |
| Certificado cliente (PEM) | SecretStore `mbc.itau.cert.{configId}` | Obrigatório em **Produção** |
| Private key (PEM) | SecretStore `mbc.itau.key.{configId}` | Obrigatório em **Produção** |
| CA / cadeia (PEM) | SecretStore `mbc.itau.ca.{configId}` ou env | Opcional |

Substituição: informe um novo valor nos campos; valores anteriores **não** são exibidos (placeholder indica “já configurado”).

---

## 3. Certificado e private key

- Formato esperado: **PEM** (`BEGIN CERTIFICATE` / `BEGIN PRIVATE KEY` ou `BEGIN RSA PRIVATE KEY`).
- Na gravação o MBC valida:
  - existência de certificado e chave quando ambos (ou um) são enviados;
  - parse X.509 e da chave;
  - **par correspondente** (mesma chave pública);
  - validade temporal (não expirado; não “ainda não válido”).
- Em produção, mTLS é **obrigatório**: sem cert/key o teste de conexão responde `CERTIFICADO_AUSENTE` / `PRIVATE_KEY_AUSENTE`.
- Não use certificado falso para “simular” produção.

---

## 4. Ambientes

| Ambiente | Token URL (padrão) | mTLS |
|----------|-------------------|------|
| `SANDBOX` / `HOMOLOGACAO` | `https://sandbox.devportal.itau.com.br/api/oauth/jwt` | Não obrigatório |
| `PRODUCAO` | `https://sts.itau.com.br/api/oauth/token` | **Obrigatório** |

Overrides (servidor):

- `ITAU_TOKEN_URL_SANDBOX` / `ITAU_API_BASE_SANDBOX`
- `ITAU_TOKEN_URL_PRODUCAO` / `ITAU_API_BASE_PRODUCAO`
- `ITAU_TLS_CA` ou `ITAU_CA_BUNDLE` (CA específica, se necessário)

Sandbox e Produção **não** são tratados como o mesmo fluxo: produção exige material mTLS e endpoints distintos.

---

## 5. Fluxo de autenticação

```
credenciais (SecretStore)
  → certificado / private key / CA
  → POST OAuth Client Credentials
  → access_token
  → cache em memória (~300s, margem 30s)
  → reutilização enquanto válido
  → renovação (forçar refresh ou expiração)
```

- Validação TLS do servidor **sempre ativa** (`rejectUnauthorized: true`).
- Não há bypass TLS.
- Tokens / Authorization / PEMs **nunca** vão para logs nem para respostas HTTP.

---

## 6. Teste de conexão

`POST .../conexao/testar` distingue, entre outros:

| `errorCode` / resultado | Significado |
|-------------------------|-------------|
| `CREDENCIAIS_AUSENTES` | Sem Client ID/Secret |
| `CLIENT_ID_AUSENTE` / `CLIENT_SECRET_AUSENTE` | Parcial |
| `CERTIFICADO_AUSENTE` / `PRIVATE_KEY_AUSENTE` | Material mTLS faltando (prod) |
| `CERTIFICADO_CHAVE_INVALIDOS` / `CERTIFICADO_EXPIRADO` | Material inválido |
| `TLS_MTLS_FALHA` | Falha TLS/mTLS |
| `OAUTH_FALHA` (ou código do provedor) | OAuth rejeitado |
| `success: true`, `authenticated: true` | Token obtido / cache válido |

Sucesso conceitual (sem secrets):

```json
{
  "success": true,
  "provider": "ITAU",
  "environment": "PRODUCAO",
  "authentication": "OAUTH2_CLIENT_CREDENTIALS",
  "mtls": true,
  "authenticated": true
}
```

---

## 7. Cuidados de segurança

- Não versionar `.pem`, `.key`, secrets ou dumps de config com material sensível.
- Não colar PEMs em issues/chats.
- SecretStore criptografado (`EncryptedLocalSecretStore`) em operação; testes usam store em memória.
- Mercado Pago continua no provider `OPEN_FINANCE_REAL` — painel e fluxo separados; não misturar credenciais.

---

## 8. O que ainda não faz parte deste procedimento

Conciliação automática, scheduler e webhook → sprints posteriores.

Saldo real, extrato e sincronização Itaú estão preparados na **MBC-ITAU-02** (requer paths oficiais via `ITAU_PATH_SALDO` / `ITAU_PATH_EXTRATO` ou `ITAU_SALDO_URL` / `ITAU_EXTRATO_URL` + credenciais do portal).
