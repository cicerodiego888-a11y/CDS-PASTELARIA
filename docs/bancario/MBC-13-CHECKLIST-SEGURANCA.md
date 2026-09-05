# MBC-13 — Checklist de segurança

- [x] Único contrato `IBankProvider` (sem contrato paralelo)
- [x] Segredos apenas em `ISecretStore`
- [x] SecretStore local classificado como transitório / desenvolvimento
- [x] Sem Vault/HSM: produção bloqueada (não mascarado)
- [x] Sem segredo em `config_integracao_bancaria`
- [x] Sem segredo em JSON de API (`sanitizarMbc` / `ISecretStore.toJSON`)
- [x] Sem segredo no frontend
- [x] Sem token em URL persistente
- [x] Logs sanitizados (`observabilidadeMbc`)
- [x] State aleatório, TTL, uso único, replay recusado
- [x] `empresa_id` do body/query sem autoridade
- [x] Feature flag padrão `false` e insuficiente sozinha
- [x] SANDBOX / HOMOLOGAÇÃO / PRODUÇÃO separados
- [ ] Certificado / mTLS oficiais (PENDENTE — sem documentação)
- [ ] Cofre de produção (PENDENTE)
- [ ] Rate limit oficial (PENDENTE)

Não registrar client_secret, access_token, certificado privado ou authorization code neste documento.
