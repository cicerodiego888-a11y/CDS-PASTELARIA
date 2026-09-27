# MBC-ITAU-01.1 — RELATÓRIO

STATUS: **CONCLUÍDO — E2E REAL PENDENTE**

Sprint de autenticação real do provider ITAU (credenciais seguras, certificado, mTLS, OAuth Client Credentials, teste de conexão).  
**Saldo / extrato / sync / conciliação não implementados** (MBC-ITAU-02).

---

## 1. Arquivos alterados / criados

### Criados
| Arquivo | Função |
|---------|--------|
| `backend/motores/bancario/providers/itau/ItauCertificadoUtil.js` | Validação PEM, par cert/key, validade temporal, metadados públicos |
| `tests/bancario/helpers/itauCertTeste.js` | Par certificado/chave efêmero em memória (node-forge; só testes) |
| `tests/bancario/motor-bancario-itau-01-1.test.js` | Suíte MBC-ITAU-01.1 |
| `docs/bancario/MBC-ITAU-CONFIGURACAO.md` | Procedimento operacional (sem segredos) |
| `docs/bancario/MBC-ITAU-01.1-RELATORIO.md` | Este relatório |

### Reutilizados / evoluídos
| Arquivo | Mudança |
|---------|---------|
| `ItauOAuthClient.js` | mTLS via `https` nativo; `rejectUnauthorized: true` sempre; CA configurável; classificação TLS vs OAuth |
| `ItauCredenciaisService.js` | CA no SecretStore; validação pré-gravação; teste de conexão com códigos claros |
| `ItauBankProvider.js` | DTO de teste (`authentication`, `mtls`, `authenticated`, `token_from_cache`) |
| `ItauConstants.js` | `chaveCa` (`mbc.itau.ca.{id}`) |
| `MotorBancarioService.js` | Passagem de `ca` / `fetchImpl` |
| `backend/rotas/bancario.js` | POST credenciais + `conexao/testar` enriquecidos |
| `frontend/erp/pages/contas-bancarias.html` | Campo CA opcional no painel Itaú |
| `frontend/erp/js/contas-bancarias.js` | Badges validade/mTLS/CA; placeholders de substituição |
| `version.js` | `SPRINT: MBC-ITAU-01.1` |
| `tests/bancario/motor-bancario-itau-01.test.js` | Ajustes ao sprint / cert de teste |

### Estruturas reutilizadas (não recriadas)
- `BankProviderRegistry` + `CODIGO_PROVIDER.ITAU`
- `EncryptedLocalSecretStore` / `MemorySecretStore`
- `sanitizarObjetoMbc`
- Conta Itaú existente + UI multi-provider
- Fluxo Mercado Pago (`OPEN_FINANCE_REAL`) intacto

---

## 2. Credenciais

| Material | Armazenamento | API / UI |
|----------|---------------|----------|
| Client ID | `aplicacao_ref` | Visível no status |
| Client Secret | `mbc.config.{id}` | Só flag `secret_configurado` |
| Certificado | `mbc.itau.cert.{id}` | Flag + validade/CN públicos |
| Private key | `mbc.itau.key.{id}` | Só flag |
| CA (opcional) | `mbc.itau.ca.{id}` ou `ITAU_TLS_CA` / `ITAU_CA_BUNDLE` | Flag / env |

- Sem texto puro de secret em banco comum.
- Sem secrets em logs, respostas HTTP ou frontend.
- Sem credenciais reais em código/testes/docs.

---

## 3. Certificado

- Parse PEM X.509 + private key via Node `crypto`.
- Associação via `X509Certificate.checkPrivateKey` (compatível Node 24+).
- Erros claros: `CERTIFICADO_AUSENTE`, `PRIVATE_KEY_AUSENTE`, `CERTIFICADO_CHAVE_INVALIDOS`, `CERTIFICADO_EXPIRADO`.
- Metadados públicos: `certificado_valido_ate`, `certificado_expirado`, `certificado_subject_cn`.
- Certificados de teste: gerados em memória; **não** simulam produção.

---

## 4. OAuth

Fluxo:

```
credenciais → SecretStore → cert/key/CA → Client Credentials → access_token → cache → reuso → renovação
```

| Ambiente | Endpoint padrão | mTLS |
|----------|-----------------|------|
| `SANDBOX` / `HOMOLOGACAO` | sandbox.devportal.itau.com.br/.../oauth/jwt | Não obrigatório |
| `PRODUCAO` | sts.itau.com.br/api/oauth/token | **Obrigatório** |

Cache em memória (~300s, margem 30s). Token nunca retornado pela API de teste.

---

## 5. mTLS

- `https.Agent` com `cert` + `key` (+ `ca` opcional).
- **Sempre** `rejectUnauthorized: true` (em agent e em `https.request`).
- Em produção com mTLS real: POST OAuth via `https` nativo (fetch/undici não aplica agent de forma confiável).
- Testes injetam `fetchImpl` mockado sem endpoint fictício embutido no produto.

---

## 6. Teste de conexão

`POST /api/bancario/configuracoes/:id/conexao/testar`

Distingue credenciais ausentes, material TLS ausente/inválido, falha TLS/mTLS, falha OAuth e sucesso autenticado.  
Não devolve secrets/tokens/PEMs.

---

## 7. UI

- Painel Itaú mantido (Client ID, Secret mascarado, Cert, Key, CA opcional).
- Indica certificado configurado e validade quando disponível.
- Substituição sem expor valores anteriores.
- Mercado Pago: painel e fluxo inalterados funcionalmente.

---

## 8. Segurança

- Sanitizer MBC cobre `Authorization`, `client_secret`, `certificate`, `private_key`.
- OAuth client não loga token/headers/PEM.
- Respostas de status/teste só com flags e metadados públicos.
- Sem `rejectUnauthorized: false`.

---

## 9. Testes executados

| Suíte | Resultado |
|-------|-----------|
| `motor-bancario-itau-01.test.js` | OK |
| `motor-bancario-itau-01-1.test.js` | OK |
| Regressão completa `tests/bancario/motor-bancario-*.test.js` | **738 / 738 OK** · **0 falhas** |

Cobertura 01.1 (mocks): registry, credenciais/cert/key ausentes, par inválido, mTLS agent, OAuth + cache + refresh, erros OAuth/TLS, produção autenticada mockada, sanitizer, MP preservado, certificado expirado.

---

## 10. Validação real contra Itaú

| Item | Status |
|------|--------|
| E2E com Client ID/Secret/certificado reais do cliente | **PENDENTE** |
| Motivo | Credenciais e certificado reais **não** estão disponíveis neste ambiente de desenvolvimento (variáveis `ITAU_*` / material operacional ausentes) |
| O que falta | Client ID + Client Secret oficiais; certificado cliente + private key (e CA se exigida); ambiente alvo (Sandbox vs Produção); execução de `POST .../conexao/testar` no ERP/homologação |

**Não foi simulado sucesso E2E.** Infraestrutura pronta; testes técnicos com mocks.

---

## 11. Pendências

1. Disponibilizar credenciais/certificado reais no ambiente operacional (fora do repositório).
2. Executar teste de conexão real e registrar resultado (Sandbox e/ou Produção).
3. Confirmar com documentação oficial Itaú se Sandbox passou a exigir mTLS (hoje: não obrigatório no MBC).
4. **Não iniciar MBC-ITAU-02** até autenticação real validada (ou aceite formal de risco).

---

## 12. Recomendação objetiva para MBC-ITAU-02

Após E2E de autenticação OK:

1. Implementar **saldo real** e **extrato real** no `ItauBankProvider` (endpoints oficiais por ambiente).
2. Reutilizar o mesmo access_token + agent mTLS já preparados.
3. Persistir movimentos no fluxo MBC existente sem duplicar motor.
4. Manter Mercado Pago intacto; isolamento por `provider` na config.
5. Continuar sem scheduler/webhook até sprint posterior dedicada.

---

## 13. Resultado esperado (checklist)

| Cadeia | Estado |
|--------|--------|
| MBC → Provider ITAU → Credenciais seguras → Certificado → mTLS → OAuth → Token → Teste de conexão | **Pronto (E2E real pendente)** |
| Mercado Pago | **Intacto** |
| Saldo/extrato Itaú | **Ainda não implementados** |
