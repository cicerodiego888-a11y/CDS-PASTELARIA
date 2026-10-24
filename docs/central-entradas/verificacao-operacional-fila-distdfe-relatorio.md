# Verificação operacional — estado real da fila DistDFe

**Prioridade:** P0  
**Data da leitura:** 17/10/2026 21:19:07 (BRT, UTC−3) / 18/10/2026 00:19:07 UTC  
**Tipo:** auditoria **somente leitura**  
**Resultado:** o estado local da fila e da inbox foi lido. **Nenhuma NF-e foi recuperada.** DistDFe real **não** foi executado nesta etapa.

---

## Confirmações de isolamento

| Controle | Evidência |
|---|---|
| Abertura do banco | `sqlite3.OPEN_READONLY` + `PRAGMA query_only = ON` (`query_only=1`) |
| Caminho | `C:\ProgramData\MercantilFiscal\dados\mercadao.db` (15.855.616 bytes; `LastWriteTime` 17/10/2026 19:57:28 BRT) |
| Journal | WAL (somente leitura da conexão) |
| `database.js` / migrations / recálculos | **não** carregados |
| `UPDATE` / `INSERT` / `DELETE` | **não** executados |
| SOAP DistDFe / `consChNFe` | **não** executados |
| Certificado PFX | **não** aberto; **não** usado para transmissão |
| NSU | **não** alterado, reiniciado, recuado nem avançado por esta auditoria |
| Cooldown | **não** forçado a expirar |
| Manifestação 210210 | **não** enviada |
| Git commit / push / merge | **não** executados |
| Código da aplicação | **não** modificado nesta etapa |

Não foi usado banco temporário para afirmar o estado real. A conexão foi a do arquivo oficial, em modo leitura.

Horários de `dfe_auditoria.created_at` e `central_entradas_nsu.data_sincronizacao` batem em UTC (ISO com `Z`). `central_entradas_eventos.created_at` também está em UTC (CENTRAL-AUDIT-01). Abaixo, UTC e BRT (UTC−3).

---

## 1. Empresa e ambiente investigados (sem segredos)

A instalação **não** é EMPRESA_SIMPLES de um único CNPJ. Não foi usado `configuracoes.cnpj` (vazio) nem `configuracoes.fiscal_ambiente` como identidade DistDFe.

| Fonte | Valor lido | Uso nesta auditoria |
|---|---|---|
| `dados\config\configuracoes.json` → `modo_operacional_global` | `MULTIEMPRESA` | Define que DistDFe percorre as empresas ativas |
| Mesmo arquivo → `empresa_operacional_id` | `2` | Contexto de UI/contrato; **não** substitui as outras empresas no DistDFe multiempresa |
| `configuracoes` (SQLite) → `cnpj` | vazio | **Não** usado como CNPJ DistDFe |
| `configuracoes` (SQLite) → `fiscal_ambiente` | `2` (homologação global) | **Não** usado como ambiente DistDFe |

Evento local que confirma o modo de sync: `central_entradas_eventos` id 2623, 17/10/2026 21:50:57 UTC — `Sincronização multiempresa: 3 empresa(s)`.

### 1.1 Cadastro `empresas` (oficial)

| empresaId | `empresas.cnpj` | Fantasia | Ativo |
|---|---|---|---|
| 1 | 38.204.469/0001-15 | PASTELARIA DO CHEFF - Matriz | 1 |
| 2 | 38.204.469/0003-87 | PASTELARIA DO CHEFF - Filial 2 | 1 |
| 3 | 38.204.469/0002-04 | PASTELARIA DO CHEFF - Filial 3 | 1 |

Razão social das três: CICERA ERICA ALVES GOMES LANCHONETE.

### 1.2 Ambiente fiscal **por empresa** (fonte DistDFe)

Tabela `empresas_configuracao_fiscal`:

| empresaId | ambiente | Significado | PFX (somente nome; arquivo não aberto) |
|---|---|---|---|
| 1 | 1 | Produção | `certificado-empresa-1.pfx` |
| 2 | 1 | Produção | `certificado-empresa-2.pfx` |
| 3 | 1 | Produção | `certificado-empresa-3.pfx` |

O painel global em homologação (`fiscal_ambiente=2`) **não** descreve essas filas. As chaves DistDFe são `(cnpj, ambiente=1)`. Linhas `ambiente=2` em `central_entradas_nsu` existem com NSU zerado desde 30/08/2026 — resíduo; **não** são o cursor de produção.

Não há uma única “empresa investigada” no DistDFe: em MULTIEMPRESA as três filas são operacionais. `empresa_operacional_id=2` indica Filial 2 no contrato/UI, mas a última DistDFe executada consultou as **três**.

---

## 2. Evidências lidas e horários

| Item | Horário | Origem |
|---|---|---|
| Leitura desta auditoria | 17/10/2026 21:19:07 BRT | relógio local |
| Arquivo `mercadao.db` | 17/10/2026 19:57:28 BRT | filesystem |
| Última DistDFe **executada** (três CNPJs) | 17/10/2026 21:50:55–57 UTC = 18:50:55–57 BRT | `dfe_auditoria` CONSULTA ids 633, 636, 639 |
| Último sync com SOAP e resumo | 17/10/2026 21:50:57 UTC | evento 2623 `sucesso` / origem `background` |
| Abertura da Central **depois** disso | 17/10/2026 22:45:51 UTC = 19:45:51 BRT | evento 2635 `ignorado` |
| Scheduler no mesmo intervalo | 17/10/2026 22:45:16 UTC | evento 2628 `ignorado` |
| Último `PARSER`/`ZIP`/`PERSISTENCIA` de lote com documentos | 27/09/2026 22:42:14 UTC | `dfe_auditoria` |
| Linhas `ERRO_BANCO` | nenhuma | `dfe_auditoria` |

`central_entradas_config`: `sync_ao_abrir=true`; política de manifestação `AUTOMATICA_CIENCIA` (lida; **não** disparada).

---

## 3. Estado real do NSU e do cooldown

Chave: `UNIQUE(cnpj, ambiente)` em `central_entradas_nsu`.  
Regra local (código, não alterada aqui): `FILA_ESGOTADA` só com `ultimo_cstat` 137 ou 138, `ult_nsu = max_nsu` e `data_sincronizacao` há menos de 1 h. `COOLDOWN_EXPLICITO` usa `cooldown_ate` (cStat 656).

Cálculo na leitura (17/10/2026 00:19:07 UTC do dia 18 / 21:19 BRT do dia 17):

### 3.1 Produção (`ambiente=1`) — cursores oficiais

| empresaId | CNPJ | ult_nsu | max_nsu | ultimo_cstat | data_sincronizacao (UTC) | cooldown_ate (UTC) | Próxima consulta à leitura | Classificação **nesta leitura** |
|---|---|---|---|---|---|---|---|---|
| 1 | 38.204.469/0001-15 | 000000000000196 | 000000000000196 | 137 | 2026-10-17T21:50:55.151Z | null | 21:50:55Z + 1 h = **22:50:55Z** (19:50:55 BRT) | Janela `FILA_ESGOTADA` **já expirada**. `ult=max` **e** cStat 137: a última resposta válida disse fila no topo **naquele instante**. Não prova ausência histórica nem ausência atual na SEFAZ. |
| 2 | 38.204.469/0003-87 | 000000000000045 | 000000000000045 | 137 | 2026-10-17T21:50:56.206Z | null | **22:50:56Z** (19:50:56 BRT) | Idem: 137 com `ult=max`; janela **expirada** na leitura. |
| 3 | 38.204.469/0002-04 | 000000000000035 | 000000000000000 | 656 | 2026-10-17T21:50:57.195Z | 2026-10-17T22:50:57.195Z | `cooldown_ate` = 19:50:57 BRT | **Não** é `FILA_ESGOTADA` (`ult ≠ max`, cStat 656). Cooldown 656 **já expirado** na leitura. `max_nsu` zerado veio da resposta 656 (auditoria: `maxNSU=000…000`). |

### 3.2 Homologação (`ambiente=2`) — não usada na última DistDFe

Três linhas com `ult_nsu=max_nsu=0`, atualizadas em 30/08/2026. Sem consulta outubro. Não representam a fila de produção.

### 3.3 Últimas consultas DistDFe (`dfe_auditoria`, tipo CONSULTA)

| UTC | CNPJ | motivo (cStat / NSU) |
|---|---|---|
| 17/10 21:50:55 | …0001-15 | `ultNSU=196 maxNSU=196 cStat=137 lotes=0` |
| 17/10 21:50:56 | …0003-87 | `ultNSU=045 maxNSU=045 cStat=137 lotes=0` |
| 17/10 21:50:57 | …0002-04 | `ultNSU=035 maxNSU=000 cStat=656 lotes=0` |
| 17/10 20:26:42–44 | os três | cStat **656** nos três CNPJs |
| 15/10 22:49:47–50 | os três | cStat **656** |
| 13/10 20:41:28–30 | os três | cStat **656** |

Resumos `SYNC` no mesmo segundo: empresas 1 e 2 com `recebidos=0`; empresa 3 `CONSUMO_INDEVIDO`. Em 17/10 20:26 a Matriz registrou `CONSUMO_INDEVIDO_NSU_RECUPERADO` (cursor local avançado pelo mecanismo 656 já existente no produto — **não** por esta auditoria).

### 3.4 O que o operador viu vs o que a fila é agora

Eventos 2628 e 2635 (17/10 22:45 UTC / 19:45 BRT): `ignorado`, texto *fila DistDFe esgotada (ultNSU = maxNSU). Nova consulta após a janela de 1 hora.* Origens `background` e `abrir_central`.

Essa mensagem **bate** com `FILA_ESGOTADA` da Matriz/Filial 2: última 137 às 18:50 BRT; 19:45 BRT ainda estava dentro da 1 h (libera 19:50 BRT). **Na leitura das 21:19 BRT a janela já tinha caído.** Não foi necessário (nem permitido) forçar expiração.

Há `CONSULTA_SOLICITADA` implícita nos eventos `SYNC_INICIADA` nesses horários; `dfe_auditoria` **não** ganha linha CONSULTA quando o SOAP é bloqueado pelo cooldown. Por isso 22:45 UTC não aparece em `dfe_auditoria`.

---

## 4. NF-e do mês atual na Central (outubro/2026)

Mês vigente da leitura: **outubro/2026**. AAMM da chave de acesso: posições 3–6 = `2610`.

| Critério | Quantidade | Observação |
|---|---|---|
| Chave AAMM `2610` (out/2026) | **0** | Nenhuma empresa |
| `data_emissao` em 2026-10 | **1** | Documento **#133**, `empresa_id` NULL |
| Chave AAMM `2609` (set/2026) | 48 | emp.1=33; emp.2=8; emp.3=7 |
| Chave AAMM `2608` (ago/2026) | 59 | emp.1=44; emp.2=11; emp.3=4 |
| Total inbox | 109 | 77 + 19 + 11 + 2 sem empresa |

O documento #133 **não** é NF-e operacional de outubro/2026: chave `23251088888888…` (40 dígitos, CNPJ de teste `88888888`), `empresa_id` nulo, `xml` 189 bytes, status `AGUARDANDO_XML`. A `data_emissao=2026-10-04` **não** coincide com o AAMM da chave (`2510`). Não conta como NF-e do mês recebida da SEFAZ.

**Conclusão local verificável:** não há NF-e de outubro/2026 persistida na Central para nenhuma das três empresas. Há dezenas de agosto e setembro. O filtro padrão “mês vigente” **esconde** setembro/agosto. Isso explica lista vazia **mesmo com documentos no banco**, se o operador estiver em outubro.

Não se declara que a SEFAZ não tenha NF-e de outubro: DistDFe de 13, 15 e 17/10 foi predominantemente **656**; a única 137 do dia 17/10 veio com **lotes=0** após o cursor já estar no topo local.

---

## 5. Persistência, XML e filtros

### 5.1 `ERRO_BANCO`

`dfe_auditoria` com `resultado=ERRO_BANCO`: **0 linhas**.  
Pendências abertas (PERSISTENCIA + ERRO_BANCO sem documento): **0**.  
A ausência de outubro **não** se explica por lote gravado com falha SQLITE nesta base.

### 5.2 Chave sem XML completo

| Métrica | Valor |
|---|---|
| `xml` nulo ou &lt; 80 bytes | 0 |
| XML curto (&lt; 500 bytes) | 1 (#133, fixture) |
| `tipo_documento=RES_NFE` | 82 (resumo; XML de resumo, não procNFe) |
| `PROC_NFE` | 26 (25 `EM_REVISAO`) |
| `RESUMO_RECEBIDO` | 65 |
| `XML_INDISPONIVEL` | 16 |
| `AGUARDANDO_XML` | 1 (#133) |

Os 82 `RES_NFE` são documentos **com chave**, em geral **sem procNFe**. Isso não os oculta da lista do mês da chave (agosto/setembro). Não cria outubro.

Última persistência com PARSER/ZIP: **27/09/2026**. Depois disso, as CONSULTA de outubro não registram lote persistido (`lotes=0` ou 656).

### 5.3 Filtros que explicam ausência na tela

| Filtro | Efeito sobre o que existe no banco |
|---|---|
| Período mês vigente (01–31/10/2026) | Zera a lista (0 chaves `2610`; o #133 só entra por `data_emissao` estimada/errada e sem `empresa_id`) |
| Empresa 2 (se o seletor seguir `empresa_operacional_id`) | 19 docs no total, **0** de outubro; 8 de setembro |
| Empresa 1 | 77 docs, **0** de outubro; 33 de setembro |
| Empresa 3 | 11 docs, **0** de outubro; 7 de setembro |
| Status (ex. só XML completo / PROC_NFE) | reduziria ainda mais; não cria outubro |

Documentos com `empresa_id` NULL: 2 (inclui #133). Ações DistDFe sobre eles cairiam no contexto global (CNPJ vazio / ambiente 2) — **não** foram acionadas aqui.

---

## 6. Limitações da investigação

1. Somente estado **local**. Não há prova de quantas NF-e outubro a SEFAZ teria entregue numa DistDFe agora.
2. `max_nsu=0` na Filial 3 após 656 é o valor persistido; não foi reinterpretado como “fila vazia”.
3. O seletor de empresa da sessão HTTP (`X-Empresa-Id`) não está no SQLite. Só há `empresa_operacional_id=2` no JSON de config.
4. Certificados: existência do caminho, sem abrir PFX nem ler senha.
5. `consChNFe` de recuperação XML aparece nos eventos (docs #4–#7, #18 às 22:45 UTC) **bloqueada pelo Gate 656** às 21:51 UTC. Esta auditoria **não** reexecutou essas consultas.
6. Avanços de NSU em 656 (`AUTO_SYNC_NSU`, Matriz 178→180 em 17/10 20:26) são histórico do sistema em produção, anteriores a esta leitura. Esta etapa não os alterou.
7. Não foi lido o conteúdo XML das notas (desnecessário para a conta de outubro).

---

## 7. Próximo passo recomendado (fundamentado)

**Não** forçar cooldown, **não** zerar NSU, **não** mandar 210210, **não** apontar DistDFe para homologação global.

1. Na UI, tirar o filtro “mês vigente” (ou selecionar setembro/2026) **sem sincronizar**, para o operador ver as 48 notas `2609` já persistidas. Isso confirma filtro, não DistDFe.
2. A janela `FILA_ESGOTADA` da última 137 (Matriz e Filial 2) **já expirou** nesta leitura. O cooldown 656 da Filial 3 **também**. Uma DistDFe real, se autorizada depois, **não** precisa “liberar” a janela à mão **neste instante**.
3. DistDFe operacional, se for autorizada em etapa seguinte: produção, `empresas.cnpj` + `empresas_configuracao_fiscal.ambiente=1` de cada empresa, certificado da própria empresa, **depois** de conferir o Gate. Expectativa: a Filial 3 ainda pode devolver 656 se a cota continuar estourada; Matriz/Filial 2 podem devolver 137 vazio **ou** 138 com outubro — só a consulta real distingue.
4. `distNSU` **não** devolve NSU já consumido. Se outubro existiu na SEFAZ e o cursor pulou com 656/137 vazio, a via restante é `consChNFe` **com chave conhecida** (DANFE), não rebobinar NSU.
5. Não tratar `ult_nsu = max_nsu` isolado como “não há NF-e”: nesta base isso só era `FILA_ESGOTADA` com cStat 137 e janela de 1 h, e essa janela já passou.

---

## Conclusão desta etapa

Auditoria de **leitura** encerrada. As NF-e de outubro/2026 **não** foram recuperadas (não era o objetivo). Localmente **não existem** documentos com chave AAMM `2610`. A mensagem de fila esgotada na abertura da Central em 19:45 BRT estava alinhada ao cooldown de 1 h após 137 com `ult=max` às 18:50 BRT. Às 21:19 BRT esse cooldown **já não estava vigente**. Outubro na SEFAZ permanece **não homologado**.

Relatório: `docs/central-entradas/verificacao-operacional-fila-distdfe-relatorio.md`.

Consultas executadas: apenas `SELECT` / `PRAGMA query_only` / `PRAGMA table_info` / `PRAGMA journal_mode` no SQLite oficial em `OPEN_READONLY`. Nenhum SOAP à SEFAZ. Nenhuma alteração no banco oficial.
