# Homologação operacional controlada — Central de Entradas

**Prioridade:** P0  
**Data:** 17/10/2026  
**Prazo do projeto:** 25/10/2026  
**Escopo:** comprovar o fluxo operacional após as Microsprints 2.6, 2.7 e 2.8  
**Resultado:** homologação **parcial**. Há evidência verificável de entrada, persistência por empresa, processamento, recuperação, revisão, vínculo de compra e pontuação. **Não** há evidência de crédito de estoque no `vincularCompra` da Central, nem de idempotência na porta pública de crédito. A barra de progresso da UI **não** prova estoque.

Esta homologação **não** está concluída só porque os testes unitários passaram.

---

## 1. Branch, HEAD e preservação

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| Subject | `implemetação Diversas` |

Alterações preexistentes **preservadas** (sem commit, push, merge ou comando destrutivo de Git):

- Microsprints 2.6 / 2.7 / 2.8 (processamento, Health, UX, score, testes e relatórios)
- Fiscal / vendas / faturamento e testes de cancelamento NFC-e
- `docs/bancario/OF-01-AUDITORIA-ITAÚ.md`

Arquivos **novos desta etapa:**

- `tests/central-entradas/homologacao-operacional-central.test.js`
- `docs/central-entradas/homologacao-operacional-relatorio.md`

Nenhuma regra fiscal, venda, financeiro, PDV ou Open Finance foi alterada. A recuperação 2.6 **não** foi reimplementada. Correções 2.6–2.8 **não** foram revertidas. `empresaId` permanece obrigatório; não há fallback global de empresa.

---

## 2. Isolamento do banco e ausência de SEFAZ

| Controle | Evidência |
|---|---|
| Banco da suíte operacional | SQLite `:memory:` injetado nos repositórios |
| `DB_DIR` | pasta temporária em `%TEMP%\cds-homolog-central-*` e `%TEMP%\cds-ce-suite-*` |
| Oficial | `C:\ProgramData\MercantilFiscal\dados` **não** foi aberto |
| SEFAZ | parser/MIIP mockados; XML local; emitter de eventos stubado na suíte operacional |
| Certificado de produção | não utilizado |
| `CDS_FORCAR_LOCAL` | `1` |

A suíte operacional **não** imprimiu o banner `BANCO OFICIAL EM USO` após o stub de `centralEventosEmitter`. `npm run test:central-entradas` abre `database.js` com o rótulo interno “BANCO OFICIAL EM USO”, mas o caminho observado foi o temporário `...\Temp\cds-ce-suite-...\mercadao.db`, não `ProgramData`.

Não houve consulta, manifestação nem transmissão real à SEFAZ.

---

## 3. Comandos e testes utilizados

```text
# Fase 1 — regressão canônica (DB_DIR temporário)
$env:CDS_FORCAR_LOCAL='1'
$env:DB_DIR = <temp>\cds-ce-suite-<guid>
npm run test:central-entradas
# exit 0

# Fase 2 + 3 — evidência operacional
$env:CDS_FORCAR_LOCAL='1'
$env:DB_DIR = <temp>\cds-ce-homolog-<guid>
node --test tests/central-entradas/homologacao-operacional-central.test.js
# 18 passou, 0 falhou, ~712 ms
```

`npm run test:central-entradas` (exit 0):

| Suíte | Resultado |
|---|---|
| `maquina-estados` | 11/0 |
| sprint 2 | 8/0 |
| sprint 4 | 5/0 |
| sprint 5 | 7/0 |
| sprint 7 | 11/0 |
| sprint 8 | 8/0 |
| sprint 9 | 7/0 |
| sprint 10 | 7/0 |
| rc1 | 9/0 |
| rc2 | 9/0 |

Suíte operacional: **18/18**.

---

## 4. Contratos inspecionados (Fase 1)

| Etapa | Contrato vigente | Onde |
|---|---|---|
| Entrada | `persistirDocumentoDfe` classifica XML, grava `empresa_id`, status `XML_COMPLETO` / `RESUMO_RECEBIDO` | `CentralDfePersistenciaService.js` |
| Consulta | `buscarPorChave(chave, empresaId)` recusa empresa inválida; `listar` filtra `empresa_id` | `CentralDocumentosRepository.js` |
| Processamento | pipeline `localizar → parse → miip → persistir → status`; exige `empresaId` | `CentralProcessamentoService.js` |
| Recuperação 2.6 | pula parse/MIIP válidos; preso em `XML_COMPLETO` se a transição de status falha | mesmo serviço + DTO `recuperado` / `etapasPuladas` |
| Revisão | `concluirRevisao` só em `EM_REVISAO` (`AGUARDANDO_REVISAO`) → `PRONTA_IMPORTACAO` | `CentralComprasBridgeService.js` |
| Importação | `registrarAberturaCompra` → `EM_IMPORTACAO`; `vincularCompra` → `IMPORTADA` + `compra_id` | mesmo serviço |
| Estoque | **fora da Central**. `vincularCompra` apenas liga a compra. Crédito em `creditarEstoqueItemCompra` → `estoqueSaldosPublico.creditarSaldo` (dual-write `produtos` + `estoque_empresa`) | `creditoEstoqueCompraViaPorta.js`, `rotas/compras.js` ~734 |
| Pontuação | mapa canônico único; `IMPORTADA: 100` | `CentralScoreDocumentoService.js` |

`empresaId` no fluxo documento → estoque:

1. Persistência grava `central_entradas_documentos.empresa_id`.
2. `processar` exige `empresaId` e `exigirDocumentoDaEmpresa` (empresa divergente responde `DOCUMENTO_NAO_ENCONTRADO`).
3. `vincularCompra` exige empresa do documento = empresa persistida da compra.
4. Crédito de estoque só ocorre se `saveCompra` / a rota chamar `creditarEstoqueItemCompra` com `empresaId`. **A Central não chama essa porta.**

---

## 5. Cenários executados e resultados

Critério: **aprovado** só com SQL/efeito persistido no banco temporário. Progresso de UI sozinho não aprova etapa.

| # | Cenário | Resultado | Evidência |
|---|---|---|---|
| 1 | Entrada de documento válido | **Aprovado** | `persistirDocumentoDfe` grava `XML_COMPLETO`, chave, XML e `empresa_id = 11` |
| 2 | Persistência e consulta por empresa | **Aprovado** | mesma chave em A e B = 2 linhas; `buscarPorChave(chave, B)` vazio para doc só de A; `listar({ empresaId })` isola |
| 3 | Processamento parser + MIIP | **Aprovado** | `parse_json`, `miip_resumo_json`, `miip_sessao_id` e status `PRONTA_IMPORTACAO` no SQLite |
| 4 | Recuperação sem repetir etapas concluídas | **Aprovado** | após falha na transição, `parse_json` permanece; 2ª execução `recuperado=true`, `etapasPuladas` inclui `parse`, `parseCalls=0` |
| 5 | Erro e retomada | **Aprovado** | parser inválido → status `ERRO` + histórico `Falha original no pipeline (parse)`; sem `forcarReprocessamento` permanece `ERRO`; com flag → `PRONTA_IMPORTACAO` |
| 6 | Transições canônicas | **Aprovado** | SQL: `XML_COMPLETO` → `EM_REVISAO` → `PRONTA_IMPORTACAO` → `EM_IMPORTACAO` → `IMPORTADA` + linhas em `central_entradas_historico` |
| 7 | Revisão e importação elegível | **Aprovado** | `concluirRevisao` + `registrarAberturaCompra` + `vincularCompra`; `compra_id` persistido |
| 8 | Documento duplicado (mesma empresa) | **Aprovado** | 2ª persistência `duplicado=true`; `COUNT(*) = 1` para `(chave, empresa_id)` |
| 9 | Crédito de estoque após importação da Central | **Reprovado** | após `vincularCompra` / `IMPORTADA`, `estoque_empresa` continua vazio. Crédito só ocorre se a porta pública for chamada à parte |
| 10 | Isolamento empresa A vs B (documentos) | **Aprovado** | processar doc B com contexto A → `DOCUMENTO_NAO_ENCONTRADO`; status/parse de B inalterados |
| 11 | Isolamento A vs B (saldo) | **Aprovado** | crédito A = 10 em `estoque_empresa`; consulta B = 0; linha B inexistente |
| 12 | Crédito duplicado / concorrência | **Reprovado** | dois créditos sequenciais 7+7 = 14; concorrência **acumula** (sem idempotência; pode haver lost-update) |
| 13 | `vincularCompra` concorrente | **Aprovado** (lado Central) | status `IMPORTADA`, mesmo `compra_id` e `empresa_id`; um registro |
| 14 | Coerência estado × histórico × UI | **Parcial** | histórico acompanha transições reais; UI marca “Estoque atualizado” em `IMPORTADA` **sem** linha em `estoque_empresa`. Em `XML_COMPLETO` a UI **não** marca parser (`posParser=false`) — alinhado à 2.7 |
| 15 | Pontuação (Fase 3) | **Aprovado** | ver seção 7 |
| 16 | `processar` sem `empresaId` | **Aprovado** | `EMPRESA_CENTRAL_AUSENTE` |
| 17 | `saveCompra` HTTP completo (itens + financeiro + estoque na mesma gravação) | **Não testado** | acoplado a `backend/rotas/compras.js`; restrição de não alterar compras/fiscal |
| 18 | Browser / tela real da Central | **Não testado** | sem servidor UI nesta etapa; modelo 14 etapas lido de `central-entradas-ux.js` |
| 19 | Sincronização / manifestação SEFAZ | **Não testado** | bloqueado de propósito |
| 20 | Parser/MIIP reais (NFeParserService + MiipService) no XML de produção | **Não testado** | mocks oficiais na suíte operacional; rc1 usa MIIP real só em fixture local do `test:central-entradas` |

---

## 6. Evidências de persistência e transições

Fluxo canônico observado no SQLite `:memory:` (teste “transições canônicas”):

1. `persistirDocumentoDfe` → `status = XML_COMPLETO`, `empresa_id = 11`
2. `processar` com pendência MIIP → `status = EM_REVISAO`, `parse_json` e `miip_resumo_json` preenchidos
3. `concluirRevisao` → `PRONTA_IMPORTACAO`
4. `registrarAberturaCompra` → `EM_IMPORTACAO`
5. `vincularCompra(compraId)` → `IMPORTADA` e `compra_id` = id da compra da mesma empresa

Histórico: `central_entradas_historico` contém `status_novo` em `EM_REVISAO`, `PRONTA_IMPORTACAO`, `EM_IMPORTACAO` e `IMPORTADA`.

Recuperação 2.6: falha simulada na transição de status deixa o documento em `XML_COMPLETO` **com** parse/MIIP persistidos; a retomada não chama o parser de novo.

---

## 7. Evidências de isolamento entre empresas

- Chave repetida em empresas 11 e 22 gera **dois** documentos (`UNIQUE(chave, empresa_id)`).
- `buscarPorChave(chave, 22)` não devolve o documento da empresa 11.
- `listar({ empresaId: 11 })` não inclui a linha da 22.
- Processar o documento da 22 com `empresaId: 11` falha com `DOCUMENTO_NAO_ENCONTRADO` (contrato de ownership; não vaza o id).
- Crédito fiscal 10 na empresa 11: `estoque_empresa` só tem linha `(produto, 11)`; `consultarSaldo(..., { empresaId: 22 })` retorna saldo fiscal 0.

---

## 8. Evidências de crédito de estoque e duplicidade

Contrato vigente:

- `CentralComprasBridgeService.vincularCompra` **não** chama `creditarEstoqueItemCompra`. Só grava `compra_id` e transiciona para `IMPORTADA` (“Compra #id gravada via saveCompra()”).
- O crédito real está em `backend/rotas/compras.js` (após insert de `compras_itens`) via `creditarEstoqueItemCompra`.
- Com `empresaId`, a porta faz dual-write em `produtos` e `estoque_empresa`. Sem `empresaId` e com `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA`.

Medido:

| Operação | Efeito |
|---|---|
| `vincularCompra` até `IMPORTADA` | `estoque_empresa` vazio |
| `creditarEstoqueItemCompra` 5 UN, empresa 11 | `estoque_empresa.saldo_fiscal = 5` |
| segundo crédito 7 + 7 | saldo 14 (duplica) |
| dois créditos concorrentes após 14 | saldo **> 14** (não idempotente) |

**Causa:** não há chave de idempotência (`compra_id`+`item` / `estoque_creditado`) na porta nem em `vincularCompra`. SQLite em memória ainda permite lost-update sob `Promise.all`.

Arquivos: `CentralComprasBridgeService.js` (vincular), `creditoEstoqueCompraViaPorta.js`, `estoqueSaldosPublico.js`, `rotas/compras.js`.

Não foi alterado peso comercial nem a porta de estoque nesta etapa (restrição: não modificar regras fiscais/compras).

---

## 9. Validação da pontuação (Fase 3)

Arquivo: `CentralScoreDocumentoService.js`. Pesos **não** alterados (0.40 / 0.25 / 0.20 / 0.10 / 0.05).

| Checagem | Resultado |
|---|---|
| `IMPORTADA: 100` | Aprovado |
| Chaves do mapa são canônicas (sem `GRAVADA`/`DUPLICADA` como chave própria) | Aprovado — regressão 2.8 |
| `GRAVADA` e `DUPLICADA` alias = `IMPORTADA` → fator status 100 | Aprovado |
| `XML_COMPLETO` 60, `EM_REVISAO` 65, `ERRO` 15, `PRONTA_IMPORTACAO` 95, `EM_IMPORTACAO` 85 | Aprovado |
| `scoreGeral(IMPORTADA) > scoreGeral(XML_COMPLETO) > scoreGeral(ERRO)` | Aprovado |
| Aliases `SINCRONIZADA`/`AGUARDANDO_REVISAO`/`EM_PROCESSAMENTO` normalizam | Aprovado |
| Transição `XML_COMPLETO → EM_REVISAO` válida; `→ NOVA` inválida | Aprovado |

---

## 10. Falhas encontradas

| ID | Falha | Causa | Arquivos | Classe |
|---|---|---|---|---|
| H-01 | Status `IMPORTADA` na Central **não** credita estoque | `vincularCompra` só persiste vínculo; crédito está na rota de compras | `CentralComprasBridgeService.js`, `rotas/compras.js` | CONTRATO / INTEGRAÇÃO |
| H-02 | UI conclui etapa “Estoque atualizado” quando `status ∈ {IMPORTADA, GRAVADA, FINALIZADA}` | `finalizado` em `central-entradas-ux.js` (~1068–1086) não consulta `estoque_empresa` | `frontend/erp/js/central-entradas-ux.js` | UX ENGANOSA |
| H-03 | Reprocessar/concorrer `creditarEstoqueItemCompra` acumula saldo | porta sem idempotência | `creditoEstoqueCompraViaPorta.js`, `estoqueSaldosPublico.js` | ESTOQUE / CONCORRÊNCIA |
| H-04 | Dual-write ainda atualiza `produtos` (saldo global) além de `estoque_empresa` | desenho 03.19 da porta; isolamento de leitura é por `estoque_empresa` | `estoqueSaldosPublico.js` | MULTIEMPRESA / LEGADO |
| H-05 | `persistirDocumentoDfe` aceita `empresaId` nulo no código (insert `empresa_id` null) | `_empresaIdOperacao` retorna null; o gate 05.74 está no processar/HTTP, não neste método | `CentralDfePersistenciaService.js` | RISCO (código; não reproduzido na suíte, que sempre passou empresa) |

H-05 não foi promovido a reprovado operacional porque o cenário executado **sempre** enviou `empresaId`. Fica como pendência de gate na persistência DistDFe.

Nenhum peso de score foi mudado. Nenhuma correção de estoque foi aplicada nesta etapa.

---

## 11. Aprovado / reprovado / não testado

### Aprovado (com evidência no banco temporário)

- Entrada XML local → `XML_COMPLETO` + `empresa_id`
- Consulta isolada por empresa
- Processamento mockado com persistência de parse/MIIP
- Recuperação 2.6 sem reparse
- Erro de parser → `ERRO` + retomada com `forcarReprocessamento`
- Máquina de estados até `IMPORTADA` + histórico
- Duplicata na mesma empresa
- Isolamento A/B de documentos e de `estoque_empresa` quando a porta é chamada com `empresaId`
- Exigência de `empresaId` no `processar`
- Mapa de pontuação 2.8
- `npm run test:central-entradas` verde

### Reprovado

- Crédito de estoque como efeito da importação da Central (`vincularCompra`)
- Proteção contra crédito duplicado / concorrência na porta pública
- Interpretação da barra de progresso “Estoque atualizado” como prova de saldo

### Não testado

- `saveCompra` HTTP ponta a ponta (itens, financeiro, dual-write na mesma transação)
- Interface no browser
- Parser e MIIP reais sobre XML de produção
- DistDFe / manifestação / MIRX / Portal Nacional / certificado
- `rc6.4-homologacao-e2e.test.js` (legado, sem `empresaId` 05.74; **não executado** para não abrir o banco oficial)
- Concorrência real de dois workers Node no crédito (apenas `Promise.all` no mesmo processo)

---

## 12. Pendências para liberar a Central

Ordem sugerida até 25/10/2026:

1. **Estoque na importação:** definir o contrato — ou a Central dispara o crédito com `empresaId` após `saveCompra` bem-sucedido, ou a UI deixa de marcar estoque só por `IMPORTADA`. Hoje os dois lados divergem (H-01 + H-02).
2. **Idempotência de crédito:** gravar efeito único por item/compra (H-03) antes de reprocessar importação em produção.
3. Gate de `empresaId` em `persistirDocumentoDfe` (H-05), sem fallback global.
4. Homologar `saveCompra` em banco temporário com itens reais, ainda sem SEFAZ.
5. Passar o fluxo na UI (lista → detalhe → revisão → compras) e conferir barra 14 etapas contra SQL, não contra percentual.
6. Manter OF-01 Itaú como NO-GO separado; não mistura com a Central.

**Liberação operacional da Central: não.** O núcleo documental (entrada → processar → revisar → vincular, com `empresaId`) está evidenciado em isolamento. O efeito de estoque e a fidelidade da UI ao estoque **não** estão.

---

## 13. Confirmações finais

| Item | Confirmação |
|---|---|
| Isolamento de banco | Sim (`:memory:` + `DB_DIR` temporário) |
| Sem `C:\ProgramData\MercantilFiscal\dados` | Sim |
| Sem SEFAZ real / certificado de produção | Sim |
| Sem remover `empresaId` / sem fallback global | Sim |
| Sem reimplementar 2.6 / sem reverter 2.6–2.8 | Sim |
| Sem commit / push / merge | Sim |
| Homologação operacional completa | **Não** |
