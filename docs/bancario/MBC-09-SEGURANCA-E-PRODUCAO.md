# MBC-09 — Segurança e produção

SEM COFRE DE PRODUÇÃO → NÃO PRONTO PARA CREDENCIAIS REAIS.

## SecretStore

- Contrato: `ISecretStore` (`set` / `get` / `delete` / `has`)
- Local: `EncryptedLocalSecretStore` (AES-256-GCM) se `MBC_SECRET_STORE_KEY` existir
- Sem chave: recusa gravar no store cifrado; factory de transição usa memória
- Nenhum secret em JSON de API, URL, frontend ou tabela funcional (`conta_bancaria`, `transacao_bancaria`, `config_integracao_bancaria`)
- Logs: `sanitizarMbc` / `observabilidadeMbc` — token, secret, senha, `state`, `authorization_code`, refresh redigidos

## Empresa

Autoridade: contexto oficial. Body, query e frontend **não** definem `empresa_id`.

## Matching / conciliação

Frontend não altera score, valor, candidato ou status oficial. Aceite chama MBC-04.

## Observabilidade permitida

conta, empresa, provider, operação, status, duração, quantidade de transações.

## Checklist de produção

Nenhum item abaixo está concluído só porque o MOCK funciona.

[ ] Provider real homologado.
[ ] Credenciais oficiais.
[ ] SecretStore de produção.
[ ] HTTPS.
[ ] Callback oficial.
[ ] Certificados quando exigidos.
[ ] OAuth/autorização real.
[ ] Refresh token seguro.
[ ] Rate limit.
[ ] Timeout.
[ ] Retry seguro.
[ ] Logs sem secrets.
[ ] Monitoramento.
[ ] Auditoria.
[ ] Revogação.
[ ] Renovação.
[ ] Paginação real.
[ ] Cursor real.
[ ] Idempotência real.
[ ] Homologação com instituição.
