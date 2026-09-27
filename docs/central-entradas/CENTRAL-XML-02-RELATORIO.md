# CENTRAL-XML-02 — Relógio da Ciência da Emissão e Motor de Manifestação

**Status:** implementado e testado com stubs. **Nenhuma manifestação real foi enviada.** Nenhuma chamada SEFAZ, SOAP ou 210210 real. O banco oficial não foi aberto nesta sprint.

Próximo passo (fora desta sprint, somente com o usuário): teste real controlado com **uma** NF-e, acompanhando 210210 → retorno → distribuição → XML.

---

## 1. Causa corrigida (achado da CENTRAL-XML-01)

O prazo da ciência era calculado a partir de `data_emissao` (`YYYY-MM-DD`), interpretada como `00:00Z`.

- **Efeito:** a janela de 10 dias era antecipada em até ~24 h.
- **Exemplo:** NF-e emitida em 17/09 às 19:58 (-03:00) tem prazo real em 27/09 às 19:58. O sistema a tratava como vencida desde 27/09 00:00Z (26/09 21:00 em Brasília).
- **Casos reais:** os docs 113 e 114 da matriz, no prazo até 27/09 22:58 UTC, eram excluídos por esse truncamento.

Além disso, a manifestação automática só rodava depois de uma sincronização bem-sucedida. A seleção era "os mais antigos primeiro", o que desperdiçava o lote com documentos já vencidos.

## 2. O que foi implementado

| Item | Onde |
|---|---|
| P0 `calcularPrazoManifestacao(documento, agora)` | `backend/motores/central-entradas/utils/prazoManifestacao.js` (novo) |
| P0 dhEmi real na listagem de pendentes | `CentralDocumentosRepository.listarPendentesManifestacao` extrai `<dhEmi>` do XML resNFe |
| P0/P1 candidato com prazo/urgência | `contracts/CandidatoManifestacaoDTO.js` |
| P3/P4/P5 seleção por urgência | `CentralManifestacaoDfeService._selecionarCandidatosManifestacao` |
| P5 proteção em qualquer caminho | `CentralManifestacaoDfeService._processarDocumento` (antes do Gate) |
| P2/P3 scheduler independente | `services/CentralManifestacaoScheduler.js` (novo), iniciado por `CentralSyncBackgroundService.iniciar()` |
| P6 alerta + painel por empresa | evento `MANIFESTACAO_ALERTA_PRAZO`; `GET /api/central-entradas/manifestacao/prazos` |
| P9 telemetria | novos tipos em `config/centralEventosTipos.js` |

### P0 — relógio

`calcularPrazoManifestacao` devolve:

- `dhEmi` (original);
- `prazoFinal` (= dhEmi + 10 × 24 h, em ISO UTC);
- `tempoRestanteMs`, `diasRestantes`, `dentroDaJanela`, `expirado`, `urgencia`, `fonte`, `valido`, `motivo`.

**Regras**

- **Fontes, em ordem:** `dhEmi` da listagem, `<dhEmi>` do XML, `parse_json`, e `dataEmissao` somente se for timestamp completo.
- **Formato aceito:** só timestamp **com hora e offset**. `YYYY-MM-DD`, ou horário sem offset, resulta em `INDETERMINADO`, sem ciência automática. Sem offset, o prazo dependeria do fuso do processo.
- **Instante do prazo:** no instante exato do prazo, o documento já é considerado expirado.
- **Propriedades:** função pura e determinística. O backend é a autoridade; o frontend não calcula prazo.

### P1 — urgência (classificação operacional do CDS)

| Urgência | Tempo restante |
|---|---|
| NORMAL | mais de 48 h |
| ATENCAO | até 48 h |
| URGENTE | até 24 h |
| EXPIRADO | 0 ou menos |
| INDETERMINADO | sem dhEmi válido |

### P2/P3 — Motor de Manifestação independente

**Fluxo:** Scheduler → `processarCandidatos` → seleção → prazo → Gate por empresa → claim → 210210 → retorno registrado e entregue ao Gate da empresa.

**Execução**

- O scheduler é iniciado com o backend, mesmo com a sincronização automática desligada. Não depende da Central aberta no navegador.
- A chamada pós-sincronização já existente foi mantida.

**Configuração**, por variável de ambiente:

| Variável | Padrão | Limites |
|---|---|---|
| `CENTRAL_MANIFESTACAO_INTERVALO_MIN` | 30 min | mín. 10, máx. 240 |
| `CENTRAL_MANIFESTACAO_LIMITE_CICLO` | 10 | máx. 50 |
| `CENTRAL_MANIFESTACAO_SCHEDULER=0` | ligado | desliga o scheduler |

A primeira execução ocorre 60 s após o boot.

**Barreiras mantidas**

- Política `AUTOMATICA_CIENCIA` obrigatória. Em MANUAL ou CONFIRMAR_OPERADOR, nenhum envio.
- Gate por empresa (656, 593, cooldown).
- Claim atômico com TTL de 10 min.
- Bloqueio de 1 h após rejeição.
- Janela pós-596.
- Envio serial.

**Sem sobreposição**

- Ciclo único por processo (`CICLO_MANIFESTACAO`), compartilhado entre o scheduler e a pós-sincronização.
- Guarda interna no próprio scheduler.
- Claim atômico e locks por documento entre processos.

### P4 — ordem de seleção

- **Ordenação:** menor tempo restante → prazo final → emissão → chave → id.
- **Faixas:**
  - URGENTE e ATENCAO seguem ordem estrita de urgência e furam a cota por empresa;
  - NORMAL mantém o round-robin por empresa (cota justa da CE-06).
- **Documentos excluídos antes da seleção:** vencidos, indeterminados, já aceitos e já rejeitados por 596.

### P5 — documento vencido

- **Sem envio:** não envia 210210, não consulta o Gate e não reserva claim, em nenhum caminho (automático, botão, MIRX).
- **Marcação única:** registra uma única vez `MANIFESTACAO_FORA_DO_PRAZO` (resultado `CIENCIA_FORA_DO_PRAZO`), sem loop, e sai da fila automática (motivo de exclusão `CIENCIA_FORA_DO_PRAZO`).
- **Retorno:** `processarDocumento` devolve `{ foraDoPrazo: true, codigo: 'CIENCIA_FORA_DO_PRAZO', prazoFinal }`.
- **Documentos históricos:** não são alterados (nenhum update de status).

### P6 — alerta

- **Evento:** `MANIFESTACAO_ALERTA_PRAZO` para ATENCAO e URGENTE, uma vez por documento e urgência, com contexto da empresa.
- **Formato:** `NF-e 123456 · Prazo para Ciência: 27/09/2026 19:58 · Tempo restante: 17h32 · Status: URGENTE`.
- **Painel:** `GET /manifestacao/prazos` (empresa do contexto) devolve a contagem por urgência, a lista ordenada e o status do scheduler. É somente leitura: sem Gate, claim ou SOAP.

### P9 — telemetria

Eventos:

- `MANIFESTACAO_CANDIDATO`
- `MANIFESTACAO_ENVIADA`
- `MANIFESTACAO_ACEITA`
- `MANIFESTACAO_REJEITADA`
- `MANIFESTACAO_FORA_DO_PRAZO`
- `MANIFESTACAO_BLOQUEADA_GATE` (agregado por empresa na seleção e por documento no caminho direto)
- `MANIFESTACAO_CLAIM_OCUPADO`

Todos levam `empresaId`, `cnpjMascarado` e `ambiente`. Nunca levam senha, caminho de PFX ou CNPJ completo (verificado em teste).

## 3. Testes — `npm run test:central-xml-02`

**Resultado: 27/27 OK, SOAP real 0.**

- **Ambiente de execução:** `DB_DIR` temporário e SQLite `:memory:`.
- **Stubs:** transporte 210210 contador, DistDFe e consChNFe proibidos, certificado fictício nunca aberto.

| # | Caso obrigatório | Teste |
|---|---|---|
| 1 | início da janela | T01 |
| 2 | 19:58 | T02 (prazo 27/09 19:58, 9h58 restantes, URGENTE; o bug antigo marcaria como vencido) |
| 3 | 23:59 | T03 |
| 4 | mesmo dia | T04 |
| 5 | próximo do vencimento | T05 (1 min antes dentro; no instante exato expirado) |
| 6 | menos de 24 h | T06 (fronteiras 24 h e 48 h) |
| 7 | vencido | T07 |
| 8 | timezone | T08 (mesmo instante em -03:00, Z, +00:00 e -02:00 gera o mesmo prazo) |
| 9 | horário de verão/offset | T09 (-02:00 em 2018/2019: exatos 240 h; exibição em Brasília) |
| 10 | sem dhEmi válido | T10 |
| 11 | múltiplas empresas | T11, T11b, T11c |
| 12 | empresa bloqueada pelo Gate | T12 (Gate simulado e Gate real isolado com 656) |
| 13 | claim ocupado | T13 |
| 14 | dois workers concorrentes | T14 (um único 210210) |
| 15 | scheduler executando duas vezes | T15, T15b, T15c |
| 16 | ciência já aceita | T16 |
| 17 | ciência rejeitada por 596 | T17 |
| 18 | fora da janela não gera SOAP | T18 |

**Testes adicionais**

- **T19:** fluxo completo simulado CANDIDATO → ENVIADA → ACEITA.
- **T20:** rejeição com contexto da empresa.
- **T21:** alerta e formato da mensagem.
- **T22:** painel por empresa.
- **T23:** extração de dhEmi pelo repositório em SQLite `:memory:`.

## 4. Regressão (P8)

Baseline: `%TEMP%\ctx-reg-central` (82 suítes). Novo: `%TEMP%\xml02-reg-final` (82 + XML-02). Cada suíte rodou com `DB_DIR` temporário próprio.

| | Baseline | Após XML-02 |
|---|---|---|
| Suítes | 82 | 83 |
| PASS | 53 | 54 (+ XML-02) |
| FAIL | 29 | 29 (as mesmas) |
| Divergências nas falhas | — | **0** |
| Acesso ao banco oficial | — | 0 |

CE-03: 12/0 (período) e 17/0 (XML). CE-04: 21/0. CE-05: 28/0. CE-06: 42/0. XML-02: 27/0.

### Testes antigos ajustados (transparência)

Quatro asserções ou fixtures contradiziam regras novas desta sprint. Foram ajustadas, e cada alteração tem um comentário `CENTRAL-XML-02` no próprio teste.

1. **CE-06 P01-09** (cota por empresa)
   - **Antes:** a empresa 1 tinha documentos com ≤ 48 h e mesmo assim se exigia cota igual 2/2/2.
   - **Conflito:** a P3 manda URGENTE/ATENCAO primeiro.
   - **Ajuste:** a fixture passou para a faixa NORMAL (≥ 3 dias restantes), onde a cota continua valendo; as asserções não mudaram. A precedência da urgência sobre a cota é coberta pelo T11b.
2. **CE-06 P01-11**
   - **Antes:** documento sem data de emissão era elegível (ia "por último").
   - **Agora:** é excluído com `PRAZO_INDETERMINADO`.
3. **CE-05 fixture `doc()`**
4. **rc33 fixture do documento**
   - Nos dois, o XML era `<resNFe/>`, um resumo sem `dhEmi`, que a Central nunca recebe da SEFAZ.
   - Foi incluído um `dhEmi` dentro da janela do relógio de cada teste. Sem isso a ciência automática (corretamente) não sai.
   - A falha pré-existente do rc33 ("cooldown persistido…") continua igual à baseline.

## 5. Decisões para validação

- **dhEmi ausente ou sem offset → sem ciência automática.** Conservador: sem prazo conhecido não há como garantir que não é um documento vencido.
  - Na auditoria XML-01, todos os resNFe reais da matriz tinham `dhEmi`.
  - O envio manual continua possível, com o Gate e o claim valendo.
- **Scheduler ligado por padrão** (30 min, 10 documentos). Só envia com a política `AUTOMATICA_CIENCIA` configurada na empresa. Pode ser desligado com `CENTRAL_MANIFESTACAO_SCHEDULER=0`.
- **Prazo de 10 × 24 h a partir do dhEmi.** É o prazo observado no cStat 596 ("[10 dias]"). O Ambiente Nacional continua sendo a autoridade final: um 596 inesperado segue o tratamento já existente (sem remanifestar).

## 6. Não alterado

- CNPJ, ambiente fiscal, certificados, NSU.
- Gate SEFAZ (apenas consultado), MUC, MIIP, Motor Fiscal, distribuição DF-e.
- Estoque, Financeiro, outras empresas.
- Banco oficial, documentos históricos.
- Nenhuma manifestação de documento vencido.

## 7. Para o teste real controlado (próxima etapa, com o usuário)

1. Consultar `GET /api/central-entradas/manifestacao/prazos` na matriz e escolher **uma** NF-e ainda dentro da janela.
2. Confirmar a política da empresa e o Gate liberado.
3. Enviar a ciência dessa única NF-e e acompanhar a sequência: `MANIFESTACAO_ENVIADA` → `MANIFESTACAO_ACEITA` (135) → próxima distribuição por NSU → procNFe/XML completo.
