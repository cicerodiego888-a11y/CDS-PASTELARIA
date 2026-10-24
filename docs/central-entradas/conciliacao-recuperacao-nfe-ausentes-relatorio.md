# Conciliação e recuperação segura de NF-e ausentes

**Prioridade:** P0 — Crítica  
**Data:** 17/10/2026  
**Prazo do projeto:** 25/10/2026  
**Tipo:** auditoria local, classificação A–E e plano de recuperação **não executado**  
**Decisão de entrega:** conciliação e diagnóstico. Qualquer recuperação real na SEFAZ ou no banco oficial exige autorização separada.

Esta sprint **não** consultou a SEFAZ, **não** usou certificado de produção, **não** abriu `C:\ProgramData\MercantilFiscal\dados`, **não** alterou NSU, **não** enviou 210210 e **não** creditou estoque.

**Não se declara que as NF-e de produção foram recuperadas.** Nenhuma recuperação real ocorreu.

---

## 1. Resumo executivo

As correções anteriores (NSU só avança após persistir o lote, `ERRO_BANCO` com chave/`empresa_id`, data estimada identificada, CNPJ em `empresas.cnpj`, DistDFe da abertura distinta de bloqueio) **estão presentes no código**. Não houve divergência que exigisse reescrevê-las.

O que faltava — e esta sprint entrega — é um **inventário classificável** a partir de evidências locais, sem inferir que a SEFAZ perdeu documentos:

| Classe | Significado | Recuperável agora? |
|---|---|---|
| A | Persistido, oculto na UI (filtro) | Sim, **local**: período/empresa. Sem SEFAZ. |
| B | `ERRO_BANCO` com chave, documento ausente | Sim se o NSU do lote **ainda não avançou** (`distNSU` autorizado). Senão, `consChNFe` autorizado. |
| C | Chave 44 dígitos conhecida, não persistido | Só com **autorização**: `consChNFe` + Gate. Não executado. |
| D | Cursor NSU avançou, sem chave | **Não** no produto (`consNSU` inexistente). |
| E | Evidência insuficiente | Não classificar causa. |

**Produção:** nenhuma NF-e real foi inventariada. O banco oficial não foi lido. Os itens abaixo são **fixtures isolados** que comprovam o classificador e os mecanismos.

`sync_ao_abrir` e o scheduler **não** foram desligados. A auditoria de abertura não foi refeita como objetivo; só houve regressão pontual.

---

## 2. Fontes de dados e arquivos auditados

### 2.1 Fontes oficiais no produto (código)

| Fonte | O que prova | O que não prova |
|---|---|---|
| `central_entradas_documentos` | Documento persistido (`chave`, `nsu`, `empresa_id`, `data_emissao`) | Ausência na tela ≠ ausência no banco |
| `dfe_auditoria` (`ERRO_BANCO` / `PERSISTENCIA`) | Falha de persistência com chave e `empresa_id` (após correção) | Consulta bloqueada por Gate/cooldown **não** gera linha DistDFe |
| `listarPendenciasPersistenciaAbertas` | Pendência aberta = `ERRO_BANCO` **sem** documento correspondente | Histórico antigo sem chave |
| `central_entradas_nsu` | Cursor atual por `(cnpj, ambiente)` | Não guarda cada NSU consumido |
| `central_entradas_historico` | Transição após persistir | Lote que falhou antes do INSERT |
| Inbox DTO | `dataEmissaoOrigem` / `dataEmissaoEstimada` | Data AAMM **não** é dhEmi fiscal |
| Filtro `MES_VIGENTE` | Oculta outros meses de propósito | Não apaga o documento |
| `consultarNotaPorChave` | `consChNFe` + Gate | **Não** rebobina NSU; não rodou nesta sprint |

### 2.2 Arquivos lidos (sem reabrir a auditoria de abertura)

`pendenciasPersistenciaDfe.js`, `distribuicaoDFe.js`, `CentralDfePersistenciaService.js`, `CentralDocumentosRepository.js`, `DocumentoFiscalInboxDTO.js`, `CentralPeriodoPadraoService.js`, `CentralConfiguracaoService.js` (`empresas.cnpj`), `CentralEntradasOrchestrator.js` (210210 só se DistDFe executou), relatórios anteriores de recuperação e de abertura.

### 2.3 Isolamento

Banner interno `BANCO OFICIAL EM USO` apontou para `%TEMP%\cds-conciliacao-nfe-*\mercadao.db`, **não** para `ProgramData`. `CDS_FORCAR_LOCAL=1`.

---

## 3. Inventário e classificação

### 3.1 Produção

**Inventário de produção: vazio de propósito.** Sem leitura autorizada do banco oficial não há chave, NSU nem `empresa_id` reais para classificar. Afirmar classe A–D sobre a loja seria especulação.

O classificador, sem fontes, devolve **Classe E** com dados faltantes: documentos, `dfe_auditoria`, `central_entradas_nsu` e lista de chaves esperadas pelo operador.

### 3.2 Fixtures isolados (evidência reproduzível)

| Item | empresa_id | Chave | NSU | Evidência | Classe | Causa |
|---|---|---|---|---|---|---|
| NF-e setembro | 11 | `352609…00099` | 3 | Linha no repositório; lista mês vigente = 0 | **A** | Filtro `periodo` (`MES_VIGENTE` em 17/10/2026) |
| NF-e outubro com dhEmi | — | `352610…00011` | — | DTO `dataEmissaoOrigem=xml` | presente | Data **fiscal** confirmada (não é ausência) |
| XML sem dhEmi | — | `352610…00011` | — | `dataEmissao=2026-10-01`, origem `chave_aamm` | presente (estimada) | Data **não** comprovada |
| SQLITE_BUSY | 11 | `352610…00011` | 9 | `ERRO_BANCO` + documento ausente; sobrevive a novo `:memory:` | **B** | Persistência falhou; NSU não avançou |
| Mesma chave após persistir | 11 | `352610…00011` | 4 | `LEFT JOIN` fecha pendência | B reconciliada | Documento existe |
| Chave operador, sem XML local | 11 | `352610…00033` | — | Lista conhecida | **C** | Plano `consChNFe` (`executaSefaz: false`) |
| Chave sem `empresa_id` | — | `352610…00033` | — | — | **E** | Falta empresa |
| `empresa_id` divergente | 22 vs 11 | `352610…00033` | — | Plano recusado | C inviável | `EMPRESA_DIVERGENTE` |
| Avanço NSU 50 sem chave | 11 | — | 50 | Cursor | **D** | Sem identificador; `consNSU` inexistente |

---

## 4. Causas comprovadas e hipóteses abertas

| Afirmação | Status |
|---|---|
| Setembro pode estar persistido e oculto pelo mês vigente | **Comprovado** (Classe A, teste) |
| Data da chave AAMM não substitui dhEmi | **Comprovado** (`dataEmissaoEstimada`) |
| `ERRO_BANCO` com chave persiste após “reinício” (`:memory:` novo) | **Comprovado** |
| Pendência deixa de ser aberta se o documento existe | **Comprovado** |
| Falha de persistência não chama `aplicarRetornoDistDfe` | **Comprovado** (correção anterior ainda no código) |
| Lote: 2º documento falha, 1º não é silenciado | **Comprovado** (`notasNovas=1`, `errosPersistencia` com chave do 2º) |
| DistDFe repetido = `duplicado`, COUNT=1 | **Comprovado** |
| Documento fica na `empresa_id` correta | **Comprovado** |
| Gate/cooldown ≠ consulta executada | **Comprovado** (`consultaExecutada: false`) |
| Ignorado/cooldown não dispara 210210 | **Comprovado** no orquestrador |
| A SEFAZ perdeu as notas da loja | **Não comprovado** |
| Houve consumo excessivo DistDFe em produção | **Não comprovado nesta sprint** (auditoria de abertura anterior: 1 SOAP por abertura se liberado) |
| Todas as ausências são recuperáveis | **Falso** — Classe D não é |

---

## 5. Resultado da auditoria de filtros

`CentralPeriodoPadraoService`: default `MES_VIGENTE` = dia 01 do mês até hoje. `TODO_PERIODO` zera o intervalo.

`CentralDocumentosRepository._montarClausulaWhere`: `date(data_emissao) >= / <=` **e** `data_emissao` não nula. Documento de 2026-09-15 **existe** com `empresa_id=11` e **some** na lista de outubro.

Correção operacional da Classe A: na UI, período “Todo o período” (ou intervalo que cubra setembro). **Não** é DistDFe. **Não** altera NSU.

Filtro de `empresa_id`: empresa B não lista documento da A. Ausência na tela da empresa errada não é nota perdida.

Paginação não foi a causa nos fixtures (total do mês = 0, não “página 2”).

---

## 6. Pendências `ERRO_BANCO` e reconciliação

Contrato atual (`pendenciasPersistenciaDfe.js`):

- Aberta: `resultado=ERRO_BANCO`, `tipo=PERSISTENCIA`, `LEFT JOIN` documento pela chave **e** `empresa_id` → `d.id IS NULL`.
- Reconciliada: o mesmo par chave+empresa já está em `central_entradas_documentos`.

Testes: aberta após novo DB em memória; fechada após persistir o XML. Sem duplicar linha (`UNIQUE(chave, empresa_id)`). Sem crédito de estoque (DistDFe não cria compra).

Pendências **históricas de produção sem chave** continuam Classe E/D: o código novo não reescreve o passado.

---

## 7. Resultados dos testes

Todos com `DB_DIR` em `%TEMP%` e `CDS_FORCAR_LOCAL=1`. Sem `rc6.4-homologacao-e2e` (SEFAZ/homologação assistida).

| Comando | Resultado |
|---|---|
| `node --test tests/central-entradas/conciliacao-recuperacao-nfe-ausentes.test.js` | **17 passou, 0 falhou** |
| `node --test` recuperação segura + nfe-não-localizada + auditoria abertura | **36 passou, 0 falhou** |
| `npm run test:central-entradas` | **exit 0** — máquina 11, s2 8, s4 5, s5 7, s7 11, s8 8, s9 7, s10 7, rc1 9, rc2 9 |
| `npm run test:central-entradas-04` (Gate) | **21 ok, 0 falha** |
| `npm run test:central-entradas-rc3.3` | **11 passou, 0 falhou** |
| `node tests/fiscal/distdfe-blindagem-05-43.test.js` | **8 ok, 0 falhou** |

### Cobertura pedida × teste

| Exigência | Onde |
|---|---|
| Persistido oculto por período | Classe A |
| Data fiscal confirmada | DTO origem `xml` |
| Sem dhEmi, data estimada | origem `chave_aamm` |
| `ERRO_BANCO` com chave e empresa | Classe B + SQL |
| Recuperação após reinício simulado | segundo `:memory:` |
| Reprocessamento idempotente | COUNT=1, `duplicado` |
| Lote com falha parcial | 1 persistido + 1 pendência com chave |
| Resposta repetida | idem |
| Chave conhecida + empresa correta | Classe C, `executaSefaz: false` |
| `empresa_id` ausente/divergente | Classe E / `EMPRESA_DIVERGENTE` |
| Gate e cooldown | plano inviável + DistDFe `consultaExecutada: false` |
| Regressão sync ao abrir | 1 POST, `consultaExecutada: false` na rota desligada |
| 210210 sem DistDFe executada | 0 `processarCandidatos` |
| DistDFe / recuperação / multiempresa / persistência | suítes acima |

---

## 8. Plano de recuperação por classe

Nenhuma linha abaixo foi executada contra a SEFAZ ou o banco oficial.

### Classe A — filtro local

- **Mecanismo:** UI `TODO_PERIODO` / intervalo que cubra a `data_emissao`.
- **Pré-requisito:** leitura (autorizada) de `central_entradas_documentos`.
- **Risco:** nenhum DistDFe.
- **Confirmação:** `listar` sem o filtro devolve o documento; `COUNT(chave, empresa_id)=1`.
- **Estoque:** não mexer.

### Classe B — pendência de persistência

- **Se `ultNSU` local ainda for anterior ao NSU do lote:** DistDFe autorizado no cursor atual (idempotente). NSU só avança se o lote persistir.
- **Se o cursor já passou:** DistDFe **não** devolve o NSU antigo. Com chave: Classe C. Sem chave: Classe D.
- **Confirmação:** pendência some no `LEFT JOIN`; um único documento.
- **Estoque:** DistDFe não cria compra; não chamar `vincularCompra`.

### Classe C — `consChNFe` (não executado)

- **Mecanismo existente:** `consultarNotaPorChave` (chave 44, Gate, contexto da empresa, CNPJ de `empresas.cnpj`).
- **Não altera** `ultNSU` DistDFe.
- **Pré-requisitos:** autorização escrita; Gate liberado; certificado da **empresa**; `empresa_id` oficial.
- **Riscos:** SOAP real; 656; XML incompleto (resNFe).
- **Proibido nesta recuperação:** 210210, crédito de estoque, rewind de NSU.
- **Confirmação:** persistido na empresa correta; `dataEmissaoEstimada` se não houver dhEmi.

`planejarConsChNFe()` nesta sprint só valida o plano (`executaSefaz: false`).

### Classe D — sem chave, cursor avançado

- **Limitação do produto:** não há `consNSU`. `distNSU` parte do `ultNSU` atual.
- **Alternativas documentadas:** XML/DANFE do fornecedor → upload; Portal Nacional; `dfe_auditoria` antiga **se** tiver chave (vira C).
- **Não inventar** NSU, chave ou rewind.

### Classe E — inconclusivo

Faltam, para a loja: dump somente leitura de documentos, auditoria, NSU e a lista de chaves que o operador espera. Sem isso não há procedimento DistDFe.

---

## 9. Limitações do histórico local

1. Sem o banco oficial, **não** há lista real de ausentes.
2. `central_entradas_nsu` é o cursor **atual**, não o filme de cada avanço.
3. `dfe_auditoria` só existe se DistDFe **executou**. Cooldown/Gate da abertura não deixam CONSULTA.
4. `ERRO_BANCO` antigo pode não ter chave.
5. Data `YYYY-MM-01` da chave **não** prova competência fiscal.
6. `cStat 137` vazio não prova que “nunca existiu nota”.
7. Upload/Portal são caminhos paralelos; esta sprint não os executou.

---

## 10. Itens que exigem autorização ou homologação operacional

1. Leitura do banco oficial (sem UPDATE) para classificar documentos **reais**.
2. DistDFe de retomada (Classe B com NSU parado), CNPJ, ambiente, janela.
3. `consChNFe` por chave (Classe C).
4. Certificado da empresa alvo (não PFX global).
5. Snapshot/backup antes de persistir.
6. Homologação assistida (`rc6.4`) — **não** rodada.
7. Revisão deste relatório **antes** de qualquer SOAP.

A recuperação real deve ser uma sprint/autorização **separada**, com a lista classificada do item 1.

---

## 11. Arquivos modificados

| Arquivo | Justificativa |
|---|---|
| `backend/motores/central-entradas/services/CentralConciliacaoNfeService.js` | **Novo.** Classifica A–E, reconcilia `ERRO_BANCO`, planeja `consChNFe` **sem** executar SEFAZ, NSU ou 210210. |
| `tests/central-entradas/conciliacao-recuperacao-nfe-ausentes.test.js` | **Novo.** Fixtures isolados das 14 exigências. |
| `docs/central-entradas/conciliacao-recuperacao-nfe-ausentes-relatorio.md` | Este relatório. |

Não foi necessário alterar DistDFe, NSU, Gate, CNPJ, estoque nem `sync_ao_abrir`: as correções anteriores continuam no código (verificado por leitura + regressão).

---

## 12. Produção e SEFAZ

| Controle | Confirmação |
|---|---|
| `C:\ProgramData\MercantilFiscal\dados` | **Não aberto, não modificado** |
| Consulta real SEFAZ | **Não executada** (`enviarDistribuicaoDfe` só mock) |
| Certificado de produção | **Não utilizado** |
| Manifestação 210210 | **Não enviada** |
| NSU de produção | **Não zerado, não retrocedido, não avançado** |
| Origem do CNPJ | `empresas.cnpj` **preservada** |
| Estoque / compras | **Não creditados** |
| `sync_ao_abrir` / scheduler | **Não desligados** |
| Commit / push / merge | **Não executados** |
| Git destrutivo | **Não executado** |

---

## 13. Critério de aceite

| Critério | Status |
|---|---|
| Inventário das evidências disponíveis | **Atendido** (produção: vazio; fixtures: seção 3) |
| Classificação sem causas inventadas | **Atendido** |
| Pendências reconciliadas com documentos locais | **Atendido** (isolado) |
| Filtros de data e empresa testados | **Atendido** |
| NSU e idempotência em isolado | **Atendido** |
| Cada classe com procedimento ou limitação | **Atendido** (seção 8) |
| Sem SEFAZ real, sem banco oficial, sem NSU indevido | **Atendido** |
| Distinção testes / evidência estática / homologação | **Atendido** |
| Não declarar NF-e recuperadas | **Atendido** |

**Aceite:** conciliação e plano revisável.  
**Fora de aceite:** “as NF-e ausentes da loja já voltaram.” Isso só depois da autorização da seção 10.
