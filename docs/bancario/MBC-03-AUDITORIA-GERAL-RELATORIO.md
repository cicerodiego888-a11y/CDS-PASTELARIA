# MBC-03 — Auditoria Geral

**STATUS GERAL: APROVADO COM RESSALVAS**

Data de execução: 2026-09-07  
Referência de código: pós MBC-ITAU-02 (`version.SPRINT = MBC-ITAU-02`)  
Escopo: auditoria técnica/arquitetural — **sem implementação de novas funcionalidades de negócio**  
Nota de nomenclatura: já existe `docs/bancario/MBC-03-TRANSACOES-IDEMPOTENCIA-SALDOS.md` (sprint histórico de fundação). Este relatório é a **auditoria geral** e usa o nome solicitado `MBC-03-AUDITORIA-GERAL-RELATORIO.md`.

---

## 1. Resumo Executivo

O Motor Bancário & Conciliação está **arquiteturalmente coerente** após Itaú-02:

- Multiempresa, multi-instituição e multi-conta **validados**.
- Mercado Pago **operacional** e isolado do ramo Itaú.
- Itaú **tecnicamente preparado** (OAuth, mTLS, saldo, extrato, sync, idempotência); **E2E real bloqueado** por credenciais/portal e paths de produto não configurados.
- Idempotência protegida por **índice UNIQUE** no banco + tratamento de race no service.
- TLS Itaú seguro (`rejectUnauthorized: true`); secrets não retornam na API de status.
- Suíte MBC: **747 / 747 PASS** (igual à referência pós-ITAU-02).

Ressalvas principais (não bloqueiam a continuidade planejada, mas devem entrar no backlog antes de produção Itaú): soft-lock de sync sem TTL; truncamento silencioso por `MAX_PAGINAS`; endpoints Itaú de saldo/extrato ainda não confirmados no portal; sobrecarga semântica `OPEN_FINANCE_REAL` = Mercado Pago.

---

## 2. Estado Atual

| Camada | Estado |
|--------|--------|
| Core MBC | Estável (contas, tx, sync, conciliação, matching) |
| Provider Mercado Pago | Via `OPEN_FINANCE_REAL` + Settlement Report — intacto |
| Provider Itaú | `ITAU` — auth + saldo/extrato/sync (mock OK; E2E pendente) |
| SecretStore | AES-GCM fail-closed; Memory só em testes |
| Frontend Contas Bancárias | Multi-provider; saldo real × conceitual; Itaú gated por credenciais |
| Testes | 747 PASS / 0 FAIL / 0 SKIP |

---

## 3. Arquitetura

Fluxo canônico preservado:

```
Empresa → Instituição → Conta → Config(provider)
  → BankProviderRegistry → IBankProvider
  → SincronizacaoBancariaService / TransacaoBancariaService
```

- Providers **não** executam SQL do ERP.
- Persistência e checkpoint ficam nos services MBC.
- Instituição financeira ≠ código de provider (modelo de dados separado).

---

## 4. Multiempresa

**Resultado: OK**

- Contas, transações, configs, consentimentos, sync e conciliações filtram por `empresa_id`.
- Rotas usam `BancarioEmpresaContextoService` / `comEmpresa`; body não redefine dono da conta.
- Testes multiempresa (ex.: MBC-14.3/14.4) cobrem isolamento A×B.

Ressalva (MÉDIO): escopo `todas` está completo principalmente em `GET /contas`; outros endpoints de leitura podem não expandir `empresaIds` da mesma forma (não é vazamento cross-tenant; é inconsistência de produto).

---

## 5. Multi-instituição

**Resultado: OK**

- Sem hardcap de quantidade de instituições por empresa.
- Catálogo `instituicao_financeira` é global (compartilhado); exclusão bloqueada se houver conta vinculada.

Ressalva (MÉDIO): CRUD de instituições mutável por perfil financeiro — risco de poluição de catálogo entre empresas (não isola catálogo por tenant).

---

## 6. Multi-conta

**Resultado: OK**

- Várias contas por empresa; mesma instituição; instituições distintas.
- `conta_bancaria_id` presente em sync, extrato, saldo, tx, checkpoint e chave de idempotência.
- Índice: uma config ativa por conta; um sync por `(empresa, conta, provider)`.

---

## 7. Providers

### IBankProvider

Contrato único: conectar/desconectar, listarContas, consultarSaldo, listarTransacoes, autorização, flags `suportaAutorizacao` / `suportaSincronizacao`.  
Extensível: novo provider implementa a classe e registra no registry — **sem** alterar regras de idempotência/persistência do core.

### BankProviderRegistry

Registrados: `MOCK`, `MOCK_OPEN_FINANCE`, `OPEN_FINANCE_REAL`, `ITAU`.  
Provider inexistente → erro tipado.  
Lista hardcoded em `criarRegistryPadrao` (aceitável nesta fase).

---

## 8. Mercado Pago

**Resultado: OK**

- OAuth, Settlement Report, persistência e UI preservados.
- Ramo `deveUsarSincronizacaoMercadoPago` isolado; ITAU-02 não entra no fluxo MP.
- Saldo bancário MP permanece `null` / “indisponível neste fluxo” (by design).
- Regressão incluída na suíte 747/747.

Ressalva (MÉDIO): código de provider `OPEN_FINANCE_REAL` representa semanticamente Mercado Pago — confusão operacional / risco futuro se OF bancário real for reativado no mesmo código.

---

## 9. Itaú

**Resultado: OK / BLOQUEADO E2E**

| Item | Status |
|------|--------|
| OAuth Client Credentials + cache | OK |
| mTLS / TLS `rejectUnauthorized: true` | OK |
| SecretStore (secret, cert, key, CA) | OK |
| Mapper saldo/extrato | OK |
| Sync + checkpoint + idempotência | OK (mock) |
| Paths saldo/extrato oficiais | **PENDENTE** (`ENDPOINT_NAO_CONFIGURADO` sem env) |
| E2E portal | **BLOQUEADO** (credenciais não liberadas) |

---

## 10. Saldo Real

**Resultado: OK**

Separação explícita:

| Tipo | Fonte | Natureza |
|------|-------|----------|
| Saldo real do banco | Provider / `sincronizacao_bancaria.saldo_bancario` | `informado_banco` |
| Saldo conceitual MBC | Σ entradas − Σ saídas em `transacao_bancaria` | `conceitual` |

- UI e API rotulam “Saldo real do banco” × “Saldo conceitual MBC”.
- Sem credenciais Itaú: mensagem “Credenciais Itaú não configuradas” — **não** R$ 0,00 falso.
- MP: saldo real indisponível neste fluxo (não inventado).

---

## 11. Transações

Tabela `transacao_bancaria` atende MP e Itaú com campos genéricos (`external_source`, `external_id`, direção, valor, datas, referência).  
Sem colunas exclusivas desnecessárias por provider.  
`external_source` Itaú = `ITAU`; MP Settlement = `MERCADO_PAGO_SETTLEMENT_REPORT`.

---

## 12. Idempotência

**Resultado: OK**

Regra oficial:

`empresa_id + conta_bancaria_id + external_source + external_id`

- Índice UNIQUE parcial no schema (`idx_transacao_bancaria_idempotencia`).
- Service: pré-check + INSERT + catch UNIQUE → `JA_EXISTENTE`.
- Testes Itaú-02 e MBC-03 histórico: 1ª CRIADA / 2ª JÁ EXISTENTE.

Ressalva (MÉDIO): sem `external_id`, não há unicidade no banco (fluxo manual/legado).

---

## 13. Checkpoint

**Resultado: OK (com ressalvas)**

- Sync genérico: cursor avança **após** persistir página.
- MP: checkpoint interno `mp_settlement_checkpoint_v1` só após persistência bem-sucedida.
- Mecanismo MBC-16.3 **não** substituído.

Ressalvas: soft-lock sem TTL; `MAX_PAGINAS=50` pode concluir `SUCESSO` com extrato incompleto.

---

## 14. Concorrência

**Resultado: OK (com ressalva de lock)**

- Mesma conta: status `SINCRONIZANDO` → 409 (soft-lock + `BEGIN IMMEDIATE`).
- Contas diferentes: podem sincronizar em paralelo (chaves distintas).
- Race de insert coberta pelo UNIQUE.

Ressalva (ALTO): crash com status `SINCRONIZANDO` sem reclaim/TTL trava a conta até intervenção.

---

## 15. SecretStore

**Resultado: OK**

- Material sensível fora das tabelas de negócio.
- GET/POST credenciais devolvem **flags** (e metadados públicos de cert), nunca secret/PEM/token.
- Frontend mascara secret; não reenvia máscara.

Ressalva (MÉDIO): método `obterCredenciaisProvider` exposto no `CONTRATO` público do Motor (não há rota HTTP, mas superfície de risco se reutilizado genericamente).

---

## 16. Segurança TLS

**Resultado: OK (escopo bancário)**

| Escopo | `rejectUnauthorized: false` |
|--------|------------------------------|
| Itaú / MP / bancario | **Ausente** — sempre `true` |
| Fiscal/NFe (fora do MBC) | Presente (legado SEFAZ) — fora do escopo desta auditoria |

CA Itaú configurável (`ITAU_TLS_CA` / SecretStore). Hostname validation padrão do Node mantida.

---

## 17. APIs

Rotas principais auditadas em `backend/rotas/bancario.js`:

- Contas, saldo conceitual, saldo-bancario, saldo-real, extrato, sincronizar, configs, OAuth MP, conexão Itaú.
- Autenticação/autorização + contexto de empresa.
- Sem secrets nas respostas de status.

Observação: rotas legadas/avançadas (MOCK) permanecem sob painel “Avançado” — não removidas (conforme escopo).

Documentação de rotas sem `if (provider ===` na camada HTTP (despacho no Motor) — alinhado a testes MBC-10/11.

---

## 18. Frontend

**Resultado: OK**

- Multi-conta / multi-provider / Itaú / MP.
- Sync Itaú por credenciais; MP por OAuth.
- Saldo real × conceitual; erros e credenciais ausentes tratados.
- Secrets não trafegam para o cliente após salvar.

---

## 19. Banco de Dados

**Resultado: OK**

- FKs declaradas; runtime com `foreign_keys=ON`.
- Índices de tenant, sync e idempotência presentes.
- Secrets em `mbc_secret_store`.

Ressalvas menores: `consentimento_of_state` sem FK completa; `external_id` nullable (parcial).

---

## 20. Observabilidade

- `registrarOperacaoMbc` + `sanitizarObjetoMbc`.
- Erros de sync sanitizam mensagens com padrões de secret/token/cert.
- Providers Itaú/MP sem `console.log` de material sensível.

Ressalva (BAIXO): sanitização agressiva pode ocultar diagnóstico útil (ex.: menção a “certificado”).

---

## 21. Testes

Comando: `node --test tests/bancario/motor-bancario-*.test.js`

| Métrica | Valor |
|---------|-------|
| PASS | **747** |
| FAIL | **0** |
| SKIP | **0** |
| Suites | 72 |

Comparação com referência pós-ITAU-02 (**747/747**): **igual — sem regressão**.

Mocks claramente identificados (ITAU-02, MOCK providers). **Não** contabilizados como E2E real Itaú.

---

## 22. Achados

| ID | Severidade | Área | Problema | Impacto | Recomendação |
|----|------------|------|----------|---------|--------------|
| A01 | ALTO | Sync / lock | Soft-lock `SINCRONIZANDO` sem TTL/reclaim | Conta pode ficar bloqueada após crash | TTL + reclaim ou endpoint admin de liberação |
| A02 | ALTO | Sync / checkpoint | `MAX_PAGINAS=50` pode marcar `SUCESSO` com `has_more` | Extrato/saldo parcial sem sinal claro | Status `PARCIAL`/`truncado: true` ou continuar com cursor |
| A03 | ALTO | Itaú / ops | Paths saldo/extrato não configurados (`ENDPOINT_NAO_CONFIGURADO`) | Auth OK, saldo/sync falham em ambiente real | Confirmar portal; setar `ITAU_PATH_*` / `ITAU_*_URL` |
| A04 | MÉDIO | Provider / modelo | `OPEN_FINANCE_REAL` semanticamente = Mercado Pago | Confusão e risco futuro OF×MP | Código `MERCADO_PAGO` ou subtipo explícito |
| A05 | MÉDIO | API / escopo | `escopo=todas` inconsistente fora de `/contas` | Operador pode achar visão consolidada incompleta | Unificar filtro de leitura |
| A06 | MÉDIO | Instituições | Catálogo global mutável | Poluição entre empresas | Restringir mutação a admin / seed |
| A07 | MÉDIO | Idempotência | Sem `external_id` não há UNIQUE | Duplicidade em fluxos manuais | Exigir id em providers; hash persistido se ausente |
| A08 | MÉDIO | Segurança API | `obterCredenciaisProvider` no CONTRATO público do Motor | Risco de exposição se reutilizado | Remover do contrato público; helper interno |
| A09 | MÉDIO | Docs | Relatórios ITAU-01/01.1 desatualizados vs código ITAU-02 | Decisões/status antigos (501, sprint string) | Atualizar índices/status ou marcar histórico |
| A10 | BAIXO | Defesa | UPDATEs internos sem `empresa_id` no WHERE | Frágil se helper for reutilizado | Incluir `empresa_id` por defesa |
| A11 | BAIXO | Observabilidade | `sanitizarErro` muito amplo | Diagnóstico opaco | Mapear `errorCode` → mensagem segura |
| A12 | BAIXO | Registry | Lista de providers hardcoded | Extensão manual | DI/config quando N crescer |
| A13 | BAIXO | Schema | `consentimento_of_state` sem FK completa | Órfãos possíveis | FK + índice por empresa |
| A14 | INFORMATIVO | Nomenclatura | Colisão “MBC-03” histórico × auditoria | Confusão documental | Manter nomes de arquivo distintos (já feito) |
| A15 | INFORMATIVO | Fiscal TLS | `rejectUnauthorized: false` no módulo fiscal | Fora do MBC | Tratar em auditoria fiscal separada |
| A16 | INFORMATIVO | Itaú E2E | Portal sem credenciais | Bloqueio esperado | Homologação após liberação |
| A17 | INFORMATIVO | Limites | Paginação listagens 200; MP 60 dias / 50 arquivos | Limites de produto | Documentar |
| A18 | INFORMATIVO | Mock | Providers MOCK distintos na UI avançada | Separação mock/real OK | Manter |

**Contagem:** CRÍTICOS: **0** · ALTOS: **3** · MÉDIOS: **6** · BAIXOS: **4** · INFORMATIVOS: **5**

Nenhuma correção automática de código foi aplicada nesta auditoria (exceto a criação deste relatório).

---

## 23. Bloqueadores

Para **produção Itaú / E2E real**:

1. Credenciais + certificado liberados pelo portal Itaú.
2. Paths/URLs oficiais de saldo e extrato configurados (`ITAU_PATH_SALDO` / `ITAU_PATH_EXTRATO` ou `ITAU_SALDO_URL` / `ITAU_EXTRATO_URL`).
3. Validação real: conexão → saldo-real → sync → conferência de idempotência.

Para **continuidade do MBC core / Mercado Pago**: **nenhum bloqueador crítico**.

---

## 24. Recomendações

**Antes da próxima fase (prioridade):**

1. Implementar reclaim/TTL do soft-lock de sincronização (A01).
2. Tratar truncamento `MAX_PAGINAS` de forma explícita (A02).
3. Configurar e validar endpoints Itaú oficiais (A03).
4. Retirar `obterCredenciaisProvider` do contrato público (A08).

**Backlog técnico:**

5. Desacoplar semanticamente Mercado Pago de `OPEN_FINANCE_REAL` (A04).
6. Unificar escopo multiempresa nas rotas de leitura (A05).
7. Endurecer política de instituições (A06) e `external_id` obrigatório em providers (A07).
8. Atualizar documentação histórica ITAU-01/01.1 como “histórico” (A09).

---

## 25. Próximo Sprint

**Recomendado: MBC-04 — Hardening Sync + Homologação Itaú (ops)**

Escopo sugerido (correções dos ALTOS + E2E quando houver credencial):

1. Soft-lock com TTL/reclaim.
2. Sinalização de sync parcial (`MAX_PAGINAS`).
3. Remoção de `obterCredenciaisProvider` do contrato público.
4. Se portal liberar: configurar paths + E2E real Itaú (conexão, saldo, sync).
5. **Não** iniciar scheduler/webhook/conciliação automática neste passo.

Alternativa se priorizar produto MP: sprint de rename/subtipo `MERCADO_PAGO` (A04) — opcional e não bloqueante.

---

## Checklist de conclusão

| Item | Status |
|------|--------|
| Auditoria executada | [x] |
| Arquitetura multiempresa validada | [x] |
| Multi-instituição validada | [x] |
| Multi-conta validada | [x] |
| Provider Registry auditado | [x] |
| IBankProvider auditado | [x] |
| Mercado Pago auditado | [x] |
| Itaú auditado | [x] |
| Saldo real auditado | [x] |
| Extrato auditado | [x] |
| Idempotência auditada | [x] |
| Checkpoint auditado | [x] |
| Concorrência auditada | [x] |
| SecretStore auditado | [x] |
| TLS auditado | [x] |
| Rotas auditadas | [x] |
| Frontend auditado | [x] |
| Banco auditado | [x] |
| Observabilidade auditada | [x] |
| Testes executados | [x] |
| 747/747 comparado | [x] (=) |
| Achados classificados | [x] |
| Relatório criado | [x] |

---

*Fim da auditoria MBC-03. Nenhum provider removido; nenhuma feature nova de negócio implementada.*
