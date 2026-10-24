# Microsprint P0.9.3 — Diagnóstico do HTTP 422 na consulta DF-e

**Prioridade:** P0  
**Data:** 18/10/2026  
**Dependência:** P0.9 — Auditoria final da operação fiscal real  
**Endpoint:** `POST /api/central-entradas/operacao-fiscal-real/consultar-dfe`

Nesta sprint **não** houve consulta DistDFe real à SEFAZ, alteração de NSU/cooldown de produção, desabilitação da barreira de autorização, aceite de token pelo cliente, acesso ao banco oficial, commit, push ou merge.

---

## 1. Causa raiz

O HTTP **422** ocorre quando a operação fiscal real está **habilitada** (`ativa: true`), mas o **pré-voo** bloqueia a emissão da autorização antes de qualquer SOAP.

A condição mais alinhada ao sintoma observado (“habilitada” + cooldown SEFAZ anteriormente indicado) é:

| Campo | Valor |
|---|---|
| `codigo` | `COOLDOWN_ATIVO` |
| `etapa` | `cooldown` |
| `statusCode` | `422` |
| `consultaExecutada` | `false` |
| `sefazConsultada` | `false` |

Fluxo: `consultarDfeReal` → `emitirAutorizacaoConsultaReal` → `executarPreVoo` → `CentralNsuService.avaliarCooldown` com `ativo: true` → erro 422 **sem** chamar DistDFe.

A UI mostrava “Habilitada” porque isso reflete só a ativação administrativa; o pré-voo (cooldown/certificado/etc.) era independente e, no fetch, o campo estável `codigo` não era copiado para o erro (`data.code` vs `data.codigo`), facilitando a percepção de um “Erro HTTP 422” genérico.

---

## 2. Condições que geram HTTP 422 (pré-voo / emissão)

| Código estável | Etapa | HTTP | Quando |
|---|---|---|---|
| `COOLDOWN_ATIVO` | `cooldown` | 422 | Cooldown SEFAZ (656 / fila esgotada 137–138) |
| `AMBIENTE_NAO_PRODUCAO` | `ambiente` | 422 | `tpAmb ≠ 1` |
| `CERTIFICADO_*` | `certificado` | 422 | Certificado A1 inválido/inapto |
| `CNPJ_AUSENTE` | `cnpj` | 422 | CNPJ ausente no contexto |
| `NSU_INDISPONIVEL` | `nsu` | 422 | Falha ao ler estado do NSU |
| `CONTEXTO_INVALIDO` / erros de contexto | `empresa` / `pre_voo` | 422 | Contexto fiscal inválido |

Outros bloqueios **não** são 422 (mantidos):

| Código | HTTP | Etapa |
|---|---|---|
| `CONFIRMACAO_CONSULTA_OBRIGATORIA` | 400 | `confirmacao` |
| `EMPRESA_OBRIGATORIA` | 400 | `empresa` |
| `OPERACAO_REAL_DESABILITADA` | 403 | `ativacao` |
| `IDENTIDADE_FISCAL_INCONSISTENTE` | 403 | `cnpj` |
| `AUTORIZACAO_CLIENTE_RECUSADA` | 400 | (rota) |

Também permanece o 422 de sync via `statusHttpSync` para `codigoErro` ∈ {`CERTIFICADO`,`CNPJ`,`CONFIG_FISCAL`,`URL_SEFAZ`} — só após pré-voo/autorização ok; **não** contorna cooldown.

---

## 3. Correções aplicadas (somente o comprovado)

1. **Resposta estruturada** em `responderErroConsultaDfeReal`: `codigo`, `etapa`, `mensagemAmigavel`, `error`, `proximaConsultaEm`, `preVoo` sanitizado (sem seed/token).
2. **Log técnico** `[CentralEntradas][OPERACAO_FISCAL_REAL]` com `etapa`, `codigo`, `empresaId`, `proximaConsultaEm` — sem senhas/tokens.
3. **Mensagem de cooldown** com horário de liberação em pt-BR (`America/Fortaleza`).
4. **UI:** `centralEntradasFetch` lê `data.codigo`; painel mostra liberação; botão **Consultar DF-e** desabilitado quando pré-voo falha; notificação usa a mensagem do backend.
5. **Cooldown mantido** — nenhuma alteração de NSU/cooldown de produção.

---

## 4. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js` | Etapas, erro estruturado, log, mensagem/liberação no pré-voo |
| `backend/motores/central-entradas/services/CentralNsuService.js` | `montarMensagemCooldown` formata horário |
| `backend/rotas/central-entradas.js` | `responderErroConsultaDfeReal` |
| `frontend/erp/js/central-entradas.js` | Fetch, status, botão, mensagem de erro |
| `frontend/erp/js/app.js` | Cache-bust ERP `p093-http422-dfe` |
| `tests/fiscal/microsprint-p0-9-3-diagnostico-http-422-consulta-dfe.test.js` | Testes isolados por causa |
| `tests/fiscal/microsprint-p0-8-1-botao-ativacao-fiscal-real.test.js` | Aceita novo cache-bust |
| `docs/fiscal/microsprint-p0-9-3-diagnostico-http-422-consulta-dfe-relatorio.md` | Este relatório |

---

## 5. Testes (resultados reais)

```text
node --test tests/fiscal/microsprint-p0-9-3-diagnostico-http-422-consulta-dfe.test.js
```

| Resultado | Valor |
|---|---|
| tests | 13 |
| pass | **13** |
| fail | **0** |
| Isolamento | `CDS_TEST_ISOLATION=1` (temp DB) |

Casos cobertos: mapeamento etapa; `COOLDOWN_ATIVO`; ambiente; certificado; CNPJ; NSU; confirmação 400; desabilitada 403; formatação de liberação; contrato da rota; UI; log sem segredos.

Regressões no mesmo ciclo (`P0.8` + `P0.8.1` + `P0.9` + `P0.9.3`):

| Resultado | Valor |
|---|---|
| tests | 46 |
| pass | **46** |
| fail | **0** |

---

## 6. O que o operador deve ver agora

- Status: **Habilitada** + pré-voo com **Cooldown SEFAZ — nova consulta a partir de &lt;data/hora&gt;**.
- Botão **Consultar DF-e (produção)** desabilitado enquanto o cooldown (ou outro pré-voo) bloquear.
- Se a API ainda retornar 422, a UI exibe a **mensagemAmigavel** (não apenas “Erro HTTP 422”).
- Log do servidor: `etapa: "cooldown"`, `codigo: "COOLDOWN_ATIVO"`, `proximaConsultaEm: <ISO>`.

---

## 7. Decisão

| Item | Status |
|---|---|
| Causa raiz identificada | **Sim** — pré-voo `COOLDOWN_ATIVO` → HTTP 422 |
| Proteções fiscais preservadas | **Sim** |
| Token do cliente aceito | **Não** |
| Consulta SEFAZ na auditoria | **Não** |
| Pronto para nova tentativa após liberação | **Sim** (sem contornar cooldown) |
