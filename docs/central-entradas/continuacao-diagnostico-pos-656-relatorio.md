# Continuação — Diagnóstico pós-cStat 656 e preparação da próxima consulta

**Tipo:** diagnóstico somente leitura (sem SEFAZ)  
**Coleta RO:** `18/10/2026, 22:37:23` (**America/Fortaleza**) · `2026-10-19T01:37:23.899Z`  
**Foco:** empresa 3 · NF-e 4.456 · destinatário `**.***.***/****-04`  
**Veredito:** **DIAGNÓSTICO CONCLUÍDO** — próxima DistDFe **não** autorizada nesta etapa

---

## 1. Confirmação da última DistDFe (relatório anterior)

| Campo | Valor |
|---|---|
| Horário | `18/10/2026, 22:23:28`–`22:23:31` Fortaleza |
| CorrelationId (eventos) | `765787ce-3191-468b-b693-4aaf15c46585` |
| Origem | `CONSULTA_DFE_REAL` |
| cStat | **656** |
| Documentos | **0** |
| NSU | **35 → 35** (preservado) |
| `cooldown_ate` gravado | `2026-10-19T02:23:31.759Z` |
| NF-e 4.456 persistida | **não** |

Evidência RO alinhada: `dfe_auditoria` ids **696–698** (`CONSULTA` / `NSU_PRESERVADO` / `SYNC_RESUMO` · `CONSUMO_INDEVIDO` · `empresa_id=3` · `01:23:31` UTC) e eventos **2827–2828** (`SYNC_INICIADA`/`SYNC_ERRO` com o mesmo correlationId).

---

## 2. Estado atual da empresa 3 (somente leitura)

### 2.1 Localização do banco (fato de filesystem — sem reabrir seleção)

| Caminho | Situação |
|---|---|
| `…\dados-pastelaria\mercadao.db` | **Ausente** nesta coleta |
| `…\dados\mercadao.db` | Contém Pastelaria (empresas 1/2/3 `38204469*`) e o NSU/cooldown da operação 4456 |
| `…\dados-preço certo\mercadao.db` | Outro cliente (~198 MB) |

A identidade operacional Pastelaria foi confirmada pelos CNPJs e pelo cursor pós-operação. **Não** se reabre correção de seleção de banco nesta etapa; apenas registra-se que o conteúdo antes em `dados-pastelaria` está, neste momento, sob `dados`.

Método: `sqlite3.OPEN_READONLY` + `PRAGMA query_only` · probe UPDATE → `SQLITE_READONLY`.

### 2.2 NSU / cooldown / FILA

| Campo | Valor atual |
|---|---|
| ultNSU / maxNSU | `000000000000035` / `000000000000035` |
| ultimo_cstat | **656** |
| cooldown_ate | `2026-10-19T02:23:31.759Z` (~**23:23:31** Fortaleza) |
| Bloqueio vigente na coleta | **`COOLDOWN_EXPLICITO` ativo** (~47 min restantes na coleta) |
| Sticky FILA estrutural | **Sim** (ult=max + cStat 656) — volta a prevalecer **após** expirar o cooldown, sem liberação admin |

### 2.3 Certificado (ambiente Pastelaria atual em `dados`)

| Campo | Valor |
|---|---|
| Path gravado | `…\dados\fiscal\certificados\certificado-empresa-3.pfx` |
| Arquivo existe | **Sim** |
| Status validação | `VÁLIDO` |
| Ambiente fiscal | 1 (produção) |
| Remap necessário agora | **Não** (path gravado = canônico e existente) |

Os remaps de código (CE-02 / ação 4456) permanecem úteis se o DB voltar a apontar path antigo; no estado atual o pré-voo **não** deve falhar por arquivo ausente.

### 2.4 OPERACAO_REAL e flags (não alteradas)

| Flag / config | Valor |
|---|---|
| `operacao_fiscal_real_empresa_3` | ativa=`true`, `temTokenSeed=true` |
| `sync_automatica_habilitada` | `true` |
| `sync_ao_abrir` | `true` |
| `sync_intervalo_minutos` | `15` |
| `recuperacao_xml_ativa` | `true` (KV) |

### 2.5 Auditoria da liberação administrativa da FILA

| Fonte | Achado |
|---|---|
| Relatório da operação | Liberação OK → `ultimo_cstat=FILA_LIBERADA_OP` → pré-voo OK → DistDFe |
| `central_entradas_eventos` | **Sem** evento dedicado `FILA_ESGOTADA_LIBERACAO_OP` / `FILA_LIBERADA` |
| `CentralNsuService.liberarFilaEsgotadaAutorizada` | Grava log operacional (`FILA_ESGOTADA_LIBERACAO_OP`), **não** emite tipicamente linha em `central_entradas_eventos` |

**Conclusão:** a liberação foi **efetiva** (permitiu a DistDFe), mas a **persistência em eventos da Central está incompleta** — lacuna de observabilidade, não de efeito. Pendência para sprint futura (evento auditável), sem alteração nesta etapa.

---

## 3. Origem do cStat 656 — concorrência / excesso

### 3.1 Caminhos de código que podem consultar DistDFe

| Caminho | Periodicidade / gatilho | Auth SOAP | Pode gerar 656? |
|---|---|---|---|
| `CONSULTA_DFE_REAL` | Manual / operação autorizada | OPERACAO_REAL obrigatória | Sim (foi o caso 22:23) |
| `CentralSyncBackgroundService` | ~15 min se `sync_automatica=true` | Runtime exige auth; sync BACKGROUND usa `permitirSemAutorizacao` na decisão, mas transporte exige auth | Ciclos frequentes; SOAP só se auth presente |
| `sincronizarAoAbrir` | Abrir Central se `sync_ao_abrir=true` | Idem | Sim se transmitir |
| MIRX / recuperação XML | Scheduler XML | `autorizaTransmissaoSefaz=false` no motor; eventos mostram bloqueio “não autorizada” | **Não** SOAP DistDFe efetivo nos eventos recentes |
| Manifestação 210210 | Scheduler separado | Auth própria | Fora do DistDFe |

### 3.2 Evidências de auditoria (empresa 3 / CNPJ `****-04`)

Nas ~48 h, `dfe_auditoria` para esse CNPJ:

| resultado | qtd |
|---|---|
| CONSULTA (SOAP DistDFe) | **8** |
| SYNC_RESUMO | 8 |
| NSU_PRESERVADO (656) | **7** |
| NSU_AVANCO (137 em 18:41) | 1 |

Linha do tempo relevante (UTC):

| Quando | Evidência | Interpretação |
|---|---|---|
| Vários ciclos 17–18/10 | CONSULTA + 656 repetidos com ult=35 | Histórico de consumo indevido no topo da fila |
| `18:41:15` | cStat **137** “Nenhum documento localizado” | DistDFe real sem docs novos |
| `22:31:28` | CONSULTA 656 + evento `SYNC_ERRO` origem **`background`** | **SOAP DistDFe associado a BACKGROUND** para este CNPJ |
| `22:37` / `22:52` / `00:09` | background `SYNC_CONCLUIDA`, `cStat=null`, cursor 196 | Ciclos **sem** novo cStat DistDFe (provável bloqueio local; sem prova de SOAP) |
| `23:40:01` | CONSULTA_DFE_REAL emp.1 (P0.12) → 656 | Outra empresa (cursor 196) |
| `01:23:31` | CONSULTA_DFE_REAL emp.3 (ação 4456) → 656 | Única DistDFe desta operação |

Eventos MIRX (`CONSULTA_DFE_POS_MANIFESTACAO`): tentam DistDFe→consChNFe mas registram **“Transmissão SEFAZ não autorizada. A consulta não foi executada.”** — **não** comprovam SOAP paralelo na janela da operação 4456.

### 3.3 Classificação

| Hipótese | Veredito |
|---|---|
| Concorrência SOAP **durante** a DistDFe 01:23:31 | **Não comprovada** — um correlationId, um SYNC_INICIADA/ERRO |
| Excesso histórico / BACKGROUND transmitindo DistDFe para o mesmo CNPJ | **Comprovado por registro** (`22:31:28` background + CONSULTA 656) e flag `sync_automatica=true` |
| MIRX causando o 656 da operação | **Refutada** pelos eventos (auth negada, sem cStat) |
| 656 = “NF-e 4456 não existe” | **Não se conclui** — 656 é rejeição de consumo; ausência na distribuição nesta consulta ≠ inexistência fiscal |

**Não** se desativam flags de produção nesta etapa.

---

## 4. Situação conhecida da NF-e 4.456

**Chave DANFE completa (44 dígitos):** não foi colada nesta continuação. Busca local usou padrão estrutural  
`…31255007000188…55001…00004456…` + número `4456` + valor `3526` + emitente Nossa Massa.

| Verificação | Resultado |
|---|---|
| `central_entradas_documentos` número 4456 | **0** |
| Match padrão de chave 4456 | **0** |
| `notas_recebidas` / `notas_recebidas_dfe` | **0** hits |
| Valor 3526 | Doc **id 56** = NF **4388** (empresa 1, 19/08/2026) — **não** é a 4456 |
| Docs do emitente `****-88` | Maior número local **4435** (empresa 3, 23/09/2026); depois 4430, 4422… — **sem 4456** |

**Conclusão local:** **nenhuma evidência de recebimento/persistência** da NF-e 4.456 (qualquer empresa). Não há associação a outra empresa sob número/chave padrão. O cStat 656 **não** prova que a nota não existe na SEFAZ.

Evidência adicional desejável antes da próxima consulta: chave de 44 dígitos do DANFE (para busca local exata e, só com autorização futura, `consChNFe`).

---

## 5. Condições para a próxima consulta autorizada

| Condição | Estado / ação |
|---|---|
| Aguardar cooldown | Até **`2026-10-19T02:23:31.759Z`** (~**23:23:31** Fortaleza) |
| Após cooldown, FILA sticky? | **Sim** (ult=max + cStat 656) → pré-voo tende a `FILA_ESGOTADA` |
| Liberação admin necessária? | **Sim**, via `POST …/liberar-fila-esgotada` (ou UI), **sem** SOAP e **sem** alterar NSU |
| Pré-voo apto após só esperar o timer? | **Não** — sticky FILA permanece |
| OPERACAO_REAL | Deve permanecer ativa para emp. 3 |
| Certificado | Path atual OK sob `dados\fiscal\…` |
| Autorização explícita DistDFe | Confirmações + emissão servidor (não strip) |
| Evitar BACKGROUND concorrente | Antes da consulta: preferir app sem ciclo BACKGROUND transmitindo, ou garantir que decisão/cooldown bloqueie SOAP; **não** desligar flag nesta etapa sem autorização |
| Uma DistDFe | Máximo uma; **sem** retry em 656/137/erro |
| Escopo | Somente empresa 3 |

Checklist pré-voo sugerido (quando houver autorização de transmissão):

1. RO: `cooldown_ate` expirado; ult/max; ultimo_cstat.  
2. Liberar FILA (admin) se sticky.  
3. Status OPERACAO_REAL + pré-voo OK.  
4. Uma `consultar-dfe` / `consultarDfeReal`.  
5. Registrar cStat, NSU, docs; parar.

---

## 6. Testes executados (isolados, sem SEFAZ)

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/sprint-ce-pastelaria-02-correcao-busca-nfe.test.js \
  tests/central-entradas/sprint-final-ce-encerramento-01.test.js
```

**27/27 pass.** Sem SOAP, sem banco oficial mutado, sem `CDS_ALLOW_OFFICIAL_DB`.

Coleta RO: script temporário `%TEMP%\cds-pos656-diag-ro.js` (fora do repo).

---

## 7. Arquivos alterados nesta etapa

**Nenhum** código de produção.  
**Criado:** este relatório.

---

## 8. Pendências e riscos residuais

1. Próxima DistDFe ainda **não** autorizada / **não** executada.  
2. Aceite da NF-e 4.456 continua **pendente**.  
3. `sync_automatica=true` + histórico de BACKGROUND com SOAP 656 no mesmo CNPJ — risco de novo consumo se BACKGROUND voltar a transmitir.  
4. Liberação FILA sem evento em `central_entradas_eventos` — observabilidade fraca.  
5. Chave DANFE 44 dígitos não disponível nesta etapa.  
6. Pasta `dados-pastelaria` ausente; conteúdo em `dados` — fato operacional, sem redesign de seleção aqui.  
7. CorrelationId da operação aparece nos **eventos**, não no `detalhe_json` da `dfe_auditoria` (rastreio parcial).

---

## 9. Conclusão

Estado pós-656 da empresa 3 está **consistente** com a operação documentada: cooldown explícito ativo até ~23:23 Fortaleza; FILA sticky estrutural permanece; certificado resolvido no path atual; NF-e 4.456 **sem** evidência local.

O 656 da consulta das 22:23 **não** foi concorrente naquele segundo, mas há **evidência de DistDFe BACKGROUND prévia** (22:31 UTC do dia 18) e de **múltiplas CONSULTA 656** no mesmo CNPJ nas últimas 48 h — contexto de consumo indevido recorrente no topo do NSU.

**Próximo passo (nova autorização):** após o cooldown, liberação admin da FILA + **uma** DistDFe controlada da empresa 3 — sem retry automático.
