# MBC-10 — Autorização e credenciais

## Autorização

Fluxo previsto (quando a instituição for definida):

1. MBC-06 gera `state` (`crypto.randomBytes`)
2. Adapter `iniciarAutorizacao`
3. Usuário autentica na instituição
4. Callback com `state` + código
5. Adapter troca código por tokens **no backend**
6. Tokens no `ISecretStore`
7. Consentimento AUTORIZADO (metadados)

Hoje: o fluxo existe no contrato e no harness de teste. **Não há Authorization Server real.**

## State

Reutilizado da MBC-06. Imprevisível, de curto prazo, uso único, ligado a empresa/conta/consentimento. Empresa da URL não é autoridade.

## Tokens

Chaves conceituais (somente se o provider exigir): client_id, client_secret, certificado, private_key, access_token, refresh_token.

Nunca em tabela funcional, frontend, JSON de API, URL, log ou código versionado.

## SecretStore

Local cifrado ≠ cofre de produção. Sem `MBC_SECRET_STORE_KEY` o store cifrado recusa gravar. PRODUCAO do provider real exige a chave. Não reutiliza TEF/PIX/LICENSE.

## Revogação

`revogarAutorizacao()` no adapter. Chamada oficial só existirá com documentação da instituição. Harness apaga tokens do store.
