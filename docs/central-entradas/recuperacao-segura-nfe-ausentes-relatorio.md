# Recuperação segura de NF-e potencialmente ausentes

**Prioridade:** P0 — Integridade documental fiscal  
**Data:** 17/10/2026  
**Prazo do projeto:** 25/10/2026  
**Tipo:** diagnóstico, recuperação controlada em teste e plano de produção **não executado**  
**Estado inicial:** correções de sincronização já implementadas; DistDFe real **não** homologado.

Esta sprint **não** consultou a SEFAZ, **não** usou certificado de produção, **não** alterou NSU de produção e **não** enviou 210210.

---

## 1. Branch, HEAD e estado inicial do Git

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| Subject | `implemetação Diversas` |
| Autor HEAD | Cicero Diego |
| Data HEAD | 2026-09-27 19:59:28 -0300 |

Worktree no início (preservado): alterações de 2.6/2.7/2.8, correção de sincronização, fiscal/vendas/faturamento, OF-01 e relatórios da Central. Sem stash.

Não houve `reset`, `checkout` destrutivo, `clean`, commit, push ou merge.

Diff da correção de sincronização já presente no worktree (antes desta sprint de recuperação): 9 arquivos, +224/−56 nas peças DistDFe/NSU/UI.

---

## 2. Evidências do histórico de NSU

### 2.1 Isolamento desta auditoria

O banco oficial `C:\ProgramData\MercantilFiscal\dados` **não foi aberto**. Não há snapshot atual de `central_entradas_nsu` nem de `dfe_auditoria` de produção nesta sprint.

Qualquer número de NSU de produção citado abaixo vem de relatório **anterior** (`CENTRAL-AUDIT-01`, sync de 27/09/2026) e **não** prova o estado de 17/10/2026.

### 2.2 Mecanismos disponíveis (código)

| Fonte | O que registra | Limite |
|---|---|---|
| `central_entradas_nsu` | `ult_nsu`, `max_nsu`, `data_sincronizacao`, `cooldown_ate`, `ultimo_cstat` por `(cnpj, ambiente)` | Cursor **atual**. Não guarda histórico de cada avanço. |
| `dfe_auditoria` | CONSULTA, ZIP, PARSER, PERSISTENCIA, NSU (`NSU_AVANCO` / `NSU_PRESERVADO`), SYNC_RESUMO, `ERRO_BANCO` | Só existe se a consulta DistDFe **foi executada**. Cooldown/Gate **não** geram linha DistDFe. |
| `central_entradas_eventos` | SYNC iniciado/concluído/ignorado (via `CentralSyncExecucaoService`) | Depende do caminho `executar()`. Em MULTIEMPRESA o cooldown global de `executar()` não bloqueia o lote. |
| `central_entradas_documentos` | Documento persistido (`chave`, `nsu`, `empresa_id`, `data_emissao`) | Ausência na tabela **não** prova que a SEFAZ nunca enviou. |
| `central_entradas_historico` | Transições de status após persistir | Não cobre lote que falhou antes do INSERT. |

### 2.3 O que o histórico **não** prova

- `ultNSU = maxNSU` **não** significa “nunca existiram notas”. Significa apenas que a última resposta DistDFe **executada** com cStat 137/138 deixou o cursor no topo da fila **naquele momento**.
- Resposta 137 (nenhum documento localizado) é consulta **executada** com lote vazio. Não prova inexistência histórica nem lote perdido.
- Consulta **ignorada** (cooldown / Gate) não aparece em `dfe_auditoria`. Sem evento de sync, não há prova local de que o operador “sincronizou”.
- Antes desta sprint, `errosPersistencia` era **somente memória** do processo. `ERRO_BANCO` em `dfe_auditoria` existia, mas frequentemente **sem chave**. Sem chave, não dá para afirmar qual NF-e falhou.

### 2.4 Informação faltante para produção (obter só com autorização)

Para um CNPJ/ambiente reais faria falta, em **leitura** (sem alterar NSU):

1. Linha atual de `central_entradas_nsu` (`ult_nsu`, `max_nsu`, `ultimo_cstat`, `cooldown_ate`, `data_sincronizacao`).
2. `dfe_auditoria` recente: CONSULTA, `ERRO_BANCO`, `NSU_AVANCO`, SYNC_RESUMO.
3. `central_entradas_documentos` do mês vigente da mesma `empresa_id`.
4. Eventos SYNC ignorados vs executados.
5. Lista de chaves esperadas pelo operador (DANFE / XML do fornecedor). Sem chave, DistDFe **não** recupera NSU já consumido.

Procedimento autorizado para obter isso: dump SQL somente leitura do banco oficial **fora** desta sprint, ou DistDFe/`consChNFe` **autorizados** (seção 8).

---

## 3. Causas comprovadas e hipóteses ainda abertas

### 3.1 Hipóteses do objetivo — classificação

| # | Hipótese | Veredito nesta sprint | Evidência |
|---|---|---|---|
| 1 | Documento nunca retornado pela consulta | **Hipótese aberta** em produção. Em teste, cStat 137 com lote vazio é consulta executada, sucesso, 0 notas — **não** é falha. | Teste isolado; DistDFe real não rodou. |
| 2 | Retornado e não persistido | **Comprovado em código** (classe 05.43 + SQLITE). Após correção, o lote fica pendente e o NSU **não** avança. | `persistirDocumentosRetorno` + testes de recuperação. |
| 3 | Persistência falhou e NSU avançou | **Comprovado como defeito anterior.** Corrigido: `aplicarRetornoDistDfe` só após `errosPersistencia.length === 0`. Lotes já perdidos **antes** da correção **não** voltam por `distNSU`. | `distribuicaoDFe.js`; relatório de correção de sync. |
| 4 | Persistido e oculto na UI | **Comprovado só para filtro de mês / empresa / `data_emissao` vazia.** Filtro mês vigente **esconde setembro** de propósito. XML sem `dhEmi` recebia data estimada `YYYY-MM-01`. | Testes de filtro e origem da data. |
| 5 | Indisponível por cooldown/Gate | **Comprovado.** DistDFe não envia; resultado agora é `consultaExecutada: false`. | `CentralSincronizacaoService`, Gate, testes. |

Não se presume que “todas as notas ausentes foram perdidas”.

### 3.2 Revisão da correção de sincronização (Fase 2)

| Item | Comprovado |
|---|---|
| Consulta ignorada ≠ consulta executada | Sim (`consultaExecutada`, `ignorado`, UI warning, agregado `sucesso` só com consulta real) |
| Falha de persistência não avança NSU | Sim |
| Retry não duplica | Sim (`UNIQUE(chave, empresa_id)` + `duplicado`) |
| Pendência retomável | Sim, **enquanto o NSU não avançou**: DistDFe devolve o mesmo lote |
| Cursor isolado por CNPJ/ambiente | Sim (`UNIQUE(cnpj, ambiente)`) |
| Cooldown, Gate, fila, rate limiter, CB | Preservados; testes de cooldown e Gate |
| 137 vazio ≠ falha ≠ “nunca existiu nota” | Sim |
| Nenhuma correção contorna o Gate | `verificarGateSefaz` antes do SOAP; teste de bloqueio |
| `errosPersistencia` durável? | **Antes:** memória + `ERRO_BANCO` muitas vezes sem chave. **Agora:** `dfe_auditoria` com **chave**, `empresa_id`, resumo SYNC com `pendenciasPersistencia`; consulta `listarPendenciasPersistenciaAbertas` sobrevive a reinício |

Manifestação 210210 **não** foi alterada.

---

## 4. Arquivos analisados e alterados

### Analisados (sem reescrever 2.6–2.8)

`CentralNsuService.js`, `CentralSincronizacaoService.js`, `CentralSyncExecucaoService.js`, `distribuicaoDFe.js`, `DfeAuditoriaService.js`, `CentralNsuRepository.js`, `NsuRecoveryService.js`, `consultarNotaPorChave`, filtros, `CENTRAL-AUDIT-01-RELATORIO.md`.

`consNSU` **não existe** neste repositório. Métodos oficiais implementados: `distNSU` (cursor atual) e `consChNFe` (chave de 44 dígitos), ambos via Gate.

### Alterados nesta sprint (além da correção de sync já existente)

| Arquivo | Papel |
|---|---|
| `backend/services/fiscal/pendenciasPersistenciaDfe.js` | **Novo.** Monta erro com chave; lista pendências abertas após reinício |
| `backend/services/fiscal/distribuicaoDFe.js` | `ERRO_BANCO` com chave/`empresa_id`; resumo SYNC com pendências |
| `backend/services/fiscal/DfeAuditoriaService.js` | `pendenciasPersistencia` no detalhe do resumo |
| `backend/motores/central-entradas/services/CentralDfePersistenciaService.js` | Origem da data: `xml` vs `chave_aamm` vs `ausente` |
| `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js` | `data_emissao_origem` na listagem (SQL, sem XML completo no payload) |
| `backend/motores/central-entradas/contracts/DocumentoFiscalInboxDTO.js` | `dataEmissaoOrigem` / `dataEmissaoEstimada` |
| `tests/central-entradas/recuperacao-segura-nfe-ausentes.test.js` | **Novo.** 13 casos isolados |

Não foram alteradas regras de compras, estoque, financeiro, PDV nem 210210.

---

## 5. Testes executados e resultados

Todos com `DB_DIR` em `%TEMP%` e `CDS_FORCAR_LOCAL=1`. Banner interno `BANCO OFICIAL EM USO` apontou para Temp, **não** para `ProgramData`. `rc6.4-homologacao-e2e.test.js` **não** foi executado.

| Suíte | Resultado |
|---|---|
| `tests/central-entradas/recuperacao-segura-nfe-ausentes.test.js` | **13 passou, 0 falhou** |
| `tests/central-entradas/nfe-nao-localizada-sync.test.js` | **9 passou, 0 falhou** |
| `tests/central-entradas/rc33-fechamento-ciclo-dfe.test.js` | **11 passou, 0 falhou** |
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | **8 ok, 0 falhou** |
| `npm run test:central-entradas-04` (Gate) | **21 ok, 0 falha** |
| `npm run test:central-entradas` | **exit 0** — máquina 11, s2 8, s4 5, s5 7, s7 11, s8 8, s9 7, s10 7, rc1 9, rc2 9 |

Falhas residuais: **nenhuma** nas suítes acima.

---

## 6. Evidências de persistência, retomada e idempotência

Comprovadas nos testes isolados (não basta `sucesso: true`):

| Cenário | Cursor | Documentos | Histórico / auditoria |
|---|---|---|---|
| Lote OK | `ultNSU` → 5 | 1 linha empresa A | consulta executada, notasNovas=1 |
| SQLITE_BUSY após 2 retries | `ultNSU` permanece 0 | 0 linhas | `ERRO_BANCO` com chave; pendência aberta |
| Reinício do processo | mesmo cursor 0, depois avança a 4 | 1 linha | pendência fecha (`LEFT JOIN` documento) |
| 2 docs, falha no segundo | lote incompleto | só o primeiro | retomada: 1 duplicado + 1 novo = 2 linhas |
| DistDFe repetido | — | COUNT=1 | `notasDuplicadas=1` |
| Cooldown | DistDFe **0** chamadas | — | `consultaExecutada=false` |
| Gate | DistDFe não chamado | cursor inalterado | `bloqueadoGate=true` |
| Multiempresa | NSU A ≠ NSU B | B não vê doc de A | isolamento `empresa_id` |
| Mês vigente | — | setembro existe, lista do mês = 0 | filtro correto |
| Sem `dhEmi` | — | `data_emissao=2026-10-01` | origem `chave_aamm` (estimada) |
| Já em `compras` | — | 1 doc `IMPORTADA` | segundo persist `duplicado` — sem segundo crédito |

`cStat 137` vazio: `consultaExecutada=true`, `sucesso=true`, `notasNovas=0`, mensagem **sem** “erro/falha”.

---

## 7. Documentos potencialmente ausentes identificáveis com segurança

| Classe | Identificável agora? | Como |
|---|---|---|
| Falha de persistência **após** esta sprint, NSU **não** avançado | Sim, em isolado; em produção após o código novo | `dfe_auditoria.ERRO_BANCO` com chave e sem documento correspondente |
| Falha antiga com NSU já avançado e `ERRO_BANCO` **com chave** | Só se a auditoria antiga tiver chave | `consChNFe` autorizado (plano) |
| Falha antiga sem chave na auditoria | **Não** | Falta a chave; DistDFe não reenvia NSU consumido |
| Nunca retornado pela SEFAZ | **Não** com dados locais | Só DistDFe/`consChNFe` autorizado ou XML do fornecedor |
| Persistido fora do mês vigente / outra empresa | Sim, se o banco for lido | Documento existe; filtro ou `empresa_id` |
| Consulta só em cooldown | Não é “nota perdida” | A consulta **não rodou** |

Nenhum documento **real** de produção foi classificado como perdido nesta sprint: o banco oficial não foi lido.

---

## 8. Plano de recuperação de produção (NÃO EXECUTADO)

Contrato aplicável no produto:

- `distNSU`: apenas a partir do `ultNSU` local. **Não** há `consNSU` implementado. Não recomendar consulta retroativa arbitrária de NSU.
- `consChNFe`: chave de 44 dígitos, Gate, **não** rebobina NSU.
- Upload manual de XML / Portal Nacional (já existentes).
- **Proibido:** zerar/retroceder NSU; 210210 como “recuperação”; DistDFe sem autorização; certificado de produção sem autorização.

### 8.1 Recuperável com evidências **locais** (ainda exige autorização para **ler** o banco oficial)

1. Documentos já em `central_entradas_documentos` ocultos por filtro de mês/empresa — correção operacional de filtro, **sem** SEFAZ.
2. `ERRO_BANCO` com chave e documento ausente **e** `ultNSU` ainda anterior ao NSU do lote — próxima sync DistDFe autorizada retoma o lote (idempotente).

### 8.2 Dependem de consulta autorizada

| Situação | Método oficial | NSU |
|---|---|---|
| Cursor parado por persistência incompleta (`PERSISTENCIA_DFE_INCOMPLETA`) | `distNSU` após Gate/cooldown | Preserva e só avança se persistir o lote |
| Chave conhecida, NSU já passou | `consChNFe` | Não altera cursor DistDFe |
| Só o XML/DANFE do fornecedor | Upload XML | Não mexe no NSU |
| Sem chave e NSU já avançado | **Não há método DistDFe no produto** | Não inventar rewind |

### 8.3 Preservar NSU e evitar duplicidade

- Nunca `UPDATE central_entradas_nsu` para trás.
- Persistência idempotente: `UNIQUE(chave, empresa_id)`.
- Conferir após recuperação: COUNT por chave+empresa = 1; `dfe_auditoria` da operação; `ult_nsu` só cresce se o lote persistiu.

### 8.4 Impedir crédito duplicado de estoque

- Se a chave já está em `compras` da mesma empresa, a Central grava/mantém `IMPORTADA` e o segundo persist é `duplicado`.
- **Não** chamar `vincularCompra` / crédito de estoque nesta recuperação DistDFe (DistDFe já não cria compra).
- Homologação anterior: crédito de estoque da Central permanece **não GO** — não usar esta sprint como evidência de estoque.

### 8.5 Verificações e autorizações **antes** de qualquer operação real

1. Autorização explícita por escrito: DistDFe e/ou `consChNFe`, CNPJ, ambiente (1 vs 2), janela.
2. Leitura prévia do cursor e de `cooldown_ate` / Gate 656.
3. Lista de chaves esperadas pelo operador.
4. Backup/snapshot do banco **antes** de persistir (procedimento operacional; não feito aqui).
5. Confirmar que o certificado é o da **empresa** alvo, não o PFX global (divergência já documentada no CENTRAL-AUDIT-01: painel global em homologação vs empresas em produção).
6. Não enviar 210210 nesta recuperação.
7. Revisar este relatório antes de executar.

---

## 9. Riscos remanescentes

| Risco | Estado |
|---|---|
| DistDFe real não homologado | Aberto |
| Lotes perdidos com NSU avançado **antes** da correção, sem chave na auditoria | Irrecuperáveis por DistDFe neste produto |
| CNPJ/ambiente errados (painel global vs empresa) | Pode devolver 137 mesmo com nota na SEFAZ |
| `ERRO_BANCO` histórico sem chave | Pendência não identificável |
| Cooldown 1 h / Gate 656 | Sync “não acha nota” enquanto a consulta não executa |
| Data estimada `YYYY-MM-01` | Entra no mês vigente; **não** é dhEmi comprovada (`dataEmissaoEstimada`) |
| `consNSU` ausente | Não há recuperação pontual por NSU antigo |

---

## 10. Isolamento, SEFAZ e Git

| Controle | Confirmação |
|---|---|
| Banco oficial `ProgramData` | **Não aberto** |
| Consulta real SEFAZ | **Não executada** |
| Certificado de produção | **Não utilizado** |
| Manifestação 210210 | **Não enviada** |
| NSU de produção | **Não zerado, não retrocedido, não sobrescrito** |
| Commit / push / merge | **Não executados** |
| Testes | `DB_DIR` temporário / `:memory:` |

---

## 11. Critério de aceite

| Critério | Status |
|---|---|
| Diagnóstico separa fatos de hipóteses | **Atendido** |
| NSU protegido em falha de persistência | **Atendido** (isolado) |
| Pendências retomáveis sem duplicação | **Atendido** (isolado) |
| Erros rastreáveis após reinício | **Atendido** (`dfe_auditoria` + lista de pendências abertas) |
| Isolamento empresa/ambiente | **Atendido** |
| Regressão aprovada | **Atendido** (suítes listadas; e2e rc6.4 não rodado de propósito) |
| Plano de produção separado e não executado | **Atendido** (seção 8) |
| Sem SEFAZ/produção sem autorização | **Atendido** |

**Aceite desta sprint:** recuperação **segura em ambiente de teste** e plano de produção para revisão.  
**Não aceite:** “as NF-e reais do mês já foram recuperadas na SEFAZ.” Isso só após autorização e execução controlada da seção 8.
