# Microsprint P0.8 — Ativação controlada do fiscal real e Central de Entradas

**Prioridade:** P0 — Operação fiscal real (DistDFe)  
**Data:** 18/10/2026  
**Dependência:** Barreira `autorizacaoTransmissaoSefaz` (P0.8 Central) · gates de certificado A1 · SQLite official guard  
**Decisão final:** **IMPLEMENTADO — PRONTO PARA ATIVAÇÃO MANUAL PELO OPERADOR**

Nesta etapa **não** houve consulta DistDFe real à SEFAZ, transmissão de eventos fiscais, manifestação 210210, alteração de NSU/cooldown em produção, acesso ao banco oficial em testes, commit, push ou merge.

---

## 1. Origem do bloqueio na interface

A mensagem **“Transmissão SEFAZ não autorizada. A consulta não foi executada.”** é produzida por `backend/services/fiscal/autorizacaoTransmissaoSefaz.js` (`resultadoConsultaNaoExecutada` / `avaliarAutorizacaoTransmissao`) quando:

1. Não há objeto de autorização; ou
2. Há flags soltas (`producao`/`operacional`) **sem** modo `OPERACAO_REAL`; ou
3. O modo não é `TESTE_ISOLADO` nem `OPERACAO_REAL` válido.

O bloqueio **não** foi removido globalmente nem substituído por variável de ambiente. Variável de ambiente sozinha **não** autoriza SOAP.

---

## 2. Modo de produção explícito

| Peça | Papel |
|---|---|
| `CentralOperacaoFiscalRealService` | Pré-voo, habilitar/desabilitar (admin), emitir autorização curta |
| Persistência | `central_entradas_config` chave `operacao_fiscal_real_empresa_{id}` |
| Autorização | `criarAutorizacaoOperacaoReal` — TTL 15 min, HMAC-like token, **sem 210210** |
| Rotas | `GET/POST /operacao-fiscal-real/*` |

### Pré-voo (antes de ativar / consultar)

- `empresaId` obrigatório (sem fallback de empresa/certificado)
- CNPJ do contexto + certificado A1 apto (`exigirCertificadoAptoParaUsoFiscal`)
- Ambiente de produção (`tpAmb=1`) exigido
- Tentativa de resolução de endpoint pelo mecanismo oficial (soft se indisponível no probe; SOAP revalida)
- Cooldown NSU ativo → bloqueia
- Confirmações explícitas no body da requisição

---

## 3. Consulta real de DF-e

Fluxo HTTP único destinado à transmissão:

`POST /api/central-entradas/operacao-fiscal-real/consultar-dfe`

Body obrigatório:

```json
{
  "confirmacaoConsultaReal": true,
  "confirmacaoAmbienteProducao": true
}
```

Encadeamento: emitir `OPERACAO_REAL` → `executarSincronizacao` com autorização → `distribuicaoDFe` (ultNSU persistido, cStat 137/656, cooldown, idempotência).

**Garantias:**

- Não reinicia/retrocede NSU para contornar 656
- Não inventa avanço de NSU sem resposta oficial
- Não autoriza manifestação automática 210210
- Sync com `OPERACAO_REAL` pula `processarCandidatos` (manifaturação) e processamentos automáticos neste caminho

---

## 4. Estados documentais / importação

Estados canônicos em `DocumentoFiscalStatus` permanecem: resumo, XML completo/indisponível, revisão, importação, cancelada, etc.

Aparição na distribuição **não** importa estoque/financeiro sozinha — importação segue fluxos MIIP/compras existentes após revisão.

---

## 5. Interface

| Ação | Comportamento |
|---|---|
| **Testar comunicação** | Prontidão local apenas (`PRONTIDAO_LOCAL`) — **sem** DistDFe |
| **Habilitar operação real** | Admin + confirmações + pré-voo |
| **Consultar DF-e (produção)** | Confirmação empresa/ambiente + DistDFe autorizado |
| **Sincronizar** (cabeçalho) | Redireciona ao fluxo explícito se habilitado; senão explica o bloqueio |
| Diagnóstico “testar SEFAZ” | Mesma prontidão local |

Mensagens da UI classificam: autorização, cooldown, ambiente, certificado, cStat 137/656.

---

## 6. Arquivos alterados / criados

| Arquivo | Alteração |
|---|---|
| `backend/services/fiscal/autorizacaoTransmissaoSefaz.js` | Modo `OPERACAO_REAL` |
| `backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js` | **Novo** — ativação/pré-voo |
| `backend/motores/central-entradas/services/CentralDiagnosticoService.js` | Teste = prontidão local |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | Propaga autorização / empresa |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Filtro `empresaIdFiltro` + auth |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | Status/habilitar/consultar; skip manif. |
| `backend/motores/central-entradas/CentralEntradasService.js` | Facade |
| `backend/rotas/central-entradas.js` | Rotas `/operacao-fiscal-real/*` |
| `frontend/erp/js/central-entradas.js` | Painel + fluxo explícito |
| `frontend/erp/js/central-diagnostico.js` | Texto prontidão local |
| `tests/fiscal/microsprint-p0-8-ativacao-operacao-fiscal-real.test.js` | **Novo** — 11 testes isolados |
| `docs/fiscal/microsprint-p0-8-ativacao-controlada-fiscal-real-relatorio.md` | Este relatório |

---

## 7. Testes

```bash
node --test tests/fiscal/microsprint-p0-8-ativacao-operacao-fiscal-real.test.js
```

**Resultado:** 11/11 pass (isolamento Temp, mocks, sem SOAP/PFX/banco oficial).

Regressão barreira anterior: `tests/central-entradas/microsprint-p0-8-bloqueio-transmissoes-sefaz.test.js` (sem SEFAZ real).

---

## 8. Procedimento seguro de ativação em produção

1. Selecionar a **empresa** correta no contexto (CNPJ esperado).
2. Confirmar **ambiente Produção** e certificado A1 válido (senha correta) na Configuração Fiscal.
3. Abrir Central de Entradas → Configuração → aba **SEFAZ**.
4. Clicar **Testar comunicação** — deve retornar prontidão local **sem** DistDFe.
5. Como **ADMIN/SUPER_ADMIN**, clicar **Habilitar operação real** e confirmar os diálogos.
6. Revisar status: pré-voo OK, ultNSU exibido, sem cooldown.
7. Clicar **Consultar DF-e (produção)** e confirmar empresa + ambiente.
8. Observar resultado: documentos novos, cStat 137 (sem novos), ou 656 (aguardar — **não** forçar).
9. Importar documentos apenas pelos fluxos de revisão/importação do CDS.
10. Para suspender: **Desabilitar** a operação real.

**Não** usar “Testar comunicação” como consulta de produção.  
**Não** transmitir 210210 automaticamente neste modo.  
**Não** alterar NSU manualmente para contornar cooldown.

---

## 9. Limitações / ressalvas

- Endpoint no pré-voo pode ficar `ENDPOINT_PENDENTE`/`ENDPOINT_SKIP` se o resolver não confirmar no probe; o envio SOAP oficial ainda exige resolução válida.
- A primeira consulta real **só** ocorre quando o operador autorizado confirma o POST `consultar-dfe`.
- Sync ao abrir / `/sincronizar` sem `OPERACAO_REAL` permanece bloqueado pela barreira (comportamento intencional).
- Manifestação do destinatário continua fora do escopo desta ativação.

---

## 10. Critérios de aceite

| # | Critério | Status |
|---|---|---|
| 1 | UI identifica por que a consulta está bloqueada | Atendido |
| 2 | Admin habilita operação real de forma explícita | Atendido |
| 3 | Consulta real usa cert/CNPJ da empresa selecionada | Atendido (contexto sem fallback) |
| 4 | NSU persistido/retomado sem regressão | Preservado no pipeline DistDFe existente |
| 5 | Documentos sem duplicidade | Preservado (persistência/idempotência existentes) |
| 6 | Importação não altera estoque indevidamente | Atendido (sem importação automática no caminho real) |
| 7 | Testes isolados passam | 11/11 |
| 8 | Relatório + procedimento de ativação | Este documento |
