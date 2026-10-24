# Microsprint P0.13 — Diagnóstico forense read-only do cStat 656 pós-P0.12

**Tipo:** diagnóstico operacional / forense  
**Data do relatório:** 18/10/2026  
**Escopo:** somente leitura — sem SOAP, sem alteração de código/banco/NSU/flags  
**Veredito:** **APROVADO COM RESSALVAS**

---

## 1. Objetivo e escopo

Investigar por que a DistDFe real da P0.12 (`empresaId=1`, produção) retornou `cStat 656` apesar de `CentralConsultaDistDfeDecisaoService` ter emitido `PRONTO_PARA_CONSULTA`.

**Feito nesta sprint**

- Leitura dos relatórios P0.9, P0.10-A, P0.10-B, P0.11, P0.12.
- Inspeção estática dos caminhos DistDFe.
- Coleta RO do SQLite oficial pelo **procedimento já autorizado em P0.10-B** (`sqlite3.OPEN_READONLY` + `PRAGMA query_only`; sem `database.js`; probe UPDATE → `SQLITE_READONLY`).
- Classificação das hipóteses H1–H6.

**Não feito**

- Nenhuma consulta SEFAZ.
- Nenhuma alteração de código, NSU, cooldown, flags ou esquema.
- Sem Electron/`server.js`/`CDS_ALLOW_OFFICIAL_DB=1`.
- Sem reexecução de suítes de teste (evitar qualquer risco de boot; resultados P0.11 já cobrem 656/mutex).

**Nomes citados no briefing e não encontrados no repositório:** `SEFAZQueryGate`, `SEFAZQueryQueue`, `SEFAZRateLimiter`, `SEFAZCooldown`, `SEFAZCircuitBreaker`. Equivalentes reais: `CentralSefazOperationalGate`, `SefazTransmissaoMutex`, `CentralConsultaDistDfeDecisaoService` (rate limit local 30s), cooldown em `CentralNsuService`.

---

## 2. Resumo executivo

| Pergunta | Resposta baseada em evidência |
|---|---|
| Houve SOAP na P0.12? | **Sim** — uma DistDFe, HTTP 200, cStat 656 (P0.12 + `dfe_auditoria` id 693–695). |
| O pré-voo local mentiu? | **Não** — `cooldown_ate` da 656 anterior (22:17Z) já havia expirado (23:17Z); decisão e Gate local estavam liberados. |
| Por que a SEFAZ rejeitou? | **Causa raiz comprovada (lado local + mensagem SEFAZ):** cursor em `ultNSU=maxNSU=196` (fila esgotada) e `ultimo_cstat=656`. Após 656, a regra local `FILA_ESGOTADA` **deixa de aplicar** (só vale para cStat 137/138). `PRONTO_PARA_CONSULTA` não modela a regra SEFAZ de “não há mais documentos — aguarde 1 h / não consuma”. |
| Houve processo concorrente na P0.12? | **Não comprovado** — P0.12 registrou ausência de CDS/Electron; mutex é **in-process**. |
| Recuperação XML causou o 656? | **Descartada** — eventos mostram bloqueio por Gate/auth; `lerConfigDeMapa` força `ativa=false`. |

**Conclusão:** o 656 da P0.12 é consistente com **nova DistDFe em CNPJ/cursor já na condição “sem documentos a pesquisar”**, após consumo anterior comprovado, com **lacuna de modelo** entre decisão local e política SEFAZ — não com falha de preservação de NSU nem com retry.

---

## 3. Linha do tempo comprovada (America/Fortaleza / UTC)

Fontes: P0.10-B, P0.12, coleta RO P0.13 (`central_entradas_eventos`, `dfe_auditoria`, `central_entradas_nsu`). Horários de evento no SQLite aparecem como UTC sem `Z` (ex.: `2026-10-18 22:17:04` ≅ `22:17:04Z` ≅ **19:17** Fortaleza).

| Horário Fortaleza | UTC (aprox.) | Evento | SOAP? | Fonte |
|---|---|---|---|---|
| ~15:39 | 18:39:18Z | `CONSULTA_DFE_REAL` emp.1 — sync sem notas (`recebidos=0`) | **Sim** (auditoria) | `dfe_auditoria` 677; P0.10-B (cStat 137) |
| ~15:40–15:41 | 18:40–18:41Z | Idem emp.2 e emp.3 — sem notas | **Sim** | auditoria 680, 683 |
| 18:46 | 18:46:29Z | `abrir_central` — bloqueio **FILA_ESGOTADA** (não enviada) | Não | evento 2783 |
| 19:17 | 22:17:03–04Z | `CONSULTA_DFE_REAL` emp.1 → **656**; NSU 196 preservado; `cooldown_ate`→23:17Z | **Sim** | eventos 2800–2801; auditoria 684–686; P0.10-B |
| 19:16–19:19 | 21:12–22:16Z | BACKGROUND / abrir_central — “não autorizada” (sem auth OPERACAO_REAL) | Não | eventos 2784–2799 |
| 19:31 | 22:31:26–28Z | BACKGROUND → **656** emp.2 e emp.3 (SOAP) | **Sim** (outras empresas) | eventos 2812–2813; auditoria 687–692 |
| 19:31 | 22:31:48Z | `abrir_central` “sucesso multiempresa” | **NÃO COMPROVADO** se houve SOAP emp.1 (cooldown ainda ativo até 20:17) | evento 2815–2816 |
| 19:31 | 22:31:43Z | `RECUPERACAO_XML_FALHA` — Gate 656 | Não (bloqueada) | evento 2814 |
| 19:37 / 19:52 | 22:37 / 22:52Z | BACKGROUND — “não enviada… cooldown 656” | Não | eventos 2817–2820 |
| 20:08 | 23:08Z | Coleta RO P0.10-B — emp.1 ainda em cooldown até 20:17 | — | relatório P0.10-B |
| 20:37 | 23:37Z | Pré-voo RO P0.12 — cooldowns NSU expirados nas 3 empresas | — | P0.12 |
| 20:39:58–20:40:01 | 23:39:58–23:40:01Z | **P0.12** `CONSULTA_DFE_REAL` emp.1 → **656**; NSU 196; cooldown→00:40Z | **Sim (única desta autorização)** | P0.12; eventos 2821–2822; auditoria 693–695 |

`SefazConsultaTrace` (RAM): **não** recuperável — lacuna.

---

## 4. Evidências da operação P0.12

| Campo | Valor |
|---|---|
| Empresa | `empresaId=1`, CNPJ `****-15` |
| Decisão | `PRONTO_PARA_CONSULTA` |
| NSU antes/depois | `196/196` → `196/196` |
| CorrelationId HTTP/orch | `5d84d0c5-5544-4785-b1f9-0cd54db68d0d` |
| CorrelationId auditoria NSU | `SYNC-20261018-204000-262` |
| cStat / lotes | 656 / 0 |
| `cooldown_ate` final | `2026-10-19T00:40:01.778Z` |
| Gate emp.1 `bloqueadoAte` | `2026-10-18T23:50:01.761Z` (progressivo ~10 min; **mais curto** que NSU 1h) |

---

## 5. Mapa dos caminhos de envio DistDFe

| Caminho | Entrada | Auth | Decisão P0.11 | Mutex | SOAP |
|---|---|---|---|---|---|
| **A. Consulta real** | `POST …/operacao-fiscal-real/consultar-dfe` → `consultarDfeReal` | OPERACAO_REAL + confirmações | Sim (pré-voo + sync) | `SefazTransmissaoMutex` | **Sim se autorizado** — foi o da P0.12 |
| **B. Sync orquestrado** | `CentralSyncExecucaoService.executar` → `CentralSincronizacaoService` | Barreira em `distribuicaoDFe.sincronizarDistribuicaoDFe` | Sim (por empresa) | Sim | Só com auth; BACKGROUND sem auth → não transmite (eventos “não autorizada”) |
| **C. Background** | `CentralSyncBackgroundService._executarCiclo` | Idem B | Sim | Sim | Ciclos pós-656: “não enviada” (cooldown) |
| **D. Abrir Central** | `sincronizarAoAbrir` | Idem B | Sim | Sim | Mesmo padrão |
| **E. Pós-manifestação / MIRX** | `CentralManifestacaoDfeService` / MIRX | Auth obrigatória | Gate + cooldown | Sim | Eventos: “Transmissão não autorizada” / Gate 656 |
| **F. Recuperação XML** | `MotorRecuperacaoXmlService` | `autorizaTransmissaoSefaz=false` (legado) | Gate + NSU cooldown | Sim | **Não autoriza ciclo SOAP** |
| **G. Diagnóstico probe** | `CentralDiagnosticoService` → `enviarDistribuicaoDfe` | Deve respeitar barreira/mutex | Gate (fail-open residual no probe — ver código) | Mutex | **Risco residual estático**; sem evidência de uso na janela P0.12 |
| **H. Legado** | `distribuicaoDfeLegado.enviarDistribuicaoDfeLegado` | Via runtime com auth | N/A direto | Via runtime | Só se chamado com auth |

Ponto SOAP efetivo: `distribuicaoDfeRuntime.enviarDistribuicaoDfe` / legado → endpoint AN `NFeDistribuicaoDFe.asmx`.

Tratamento 656: `CentralNsuService.aplicarRetornoDistDfe` — `preservarNsu: true`, `cooldownAte=+1h`, sem retry no loop.

---

## 6. Hipóteses H1–H6

### H1 — Consumo anterior pela própria empresa — **CONFIRMADA**

- DistDFe SOAP emp.1 em **18:39Z** (fila vazia) e **22:17Z** (656), ambas com CNPJ `****-15` e NSU 196.
- P0.12 às **23:40Z** é a terceira DistDFe do dia no mesmo cursor `196/196`.
- xMotivo SEFAZ na P0.12: aguardar 1 h **quando não existem mais documentos**.

### H2 — Concorrência entre processos — **DESCARTADA** (para a P0.12) / **INDÍCIO** (arquitetura)

- P0.12: sem CDS/Electron em execução no momento da operação.
- `SefazTransmissaoMutex` é **singleton de processo** (`SefazTransmissaoMutex.js`) — **não** coordena multi-processo.
- Não há evidência de segundo SOAP emp.1 entre 22:17Z e 23:40Z.

### H3 — Motores paralelos — **DESCARTADA** como causa do 656 da P0.12

- `recuperacao_xml_ativa=true` no KV, mas `MotorRecuperacaoXmlConfig.lerConfigDeMapa` força `ativa=false` / `autorizaTransmissaoSefaz=false`.
- Eventos MIRX/XML: bloqueio por auth ou Gate — **sem SOAP efetivo**.
- BACKGROUND após 22:17: “não enviada… cooldown” para a janela emp.1.

### H4 — Divergência de cooldown — **CONFIRMADA**

Código (`CentralNsuService.avaliarCooldown`, ~303–341):

1. `cooldown_ate` ativo → bloqueia (`COOLDOWN_EXPLICITO`).
2. Senão, `FILA_ESGOTADA` **somente se** `ultimo_cstat ∈ {137,138}` **e** `ultNSU=maxNSU` **e** &lt;1 h desde `data_sincronizacao`.
3. Após 656, `ultimo_cstat=656` → ramo (2) **não aplica**, mesmo com `ult=max`.
4. Quando `cooldown_ate` expira (23:17Z), a decisão local vira `PRONTO_PARA_CONSULTA` ainda com fila esgotada.
5. Gate progressivo (10 min na 1ª ocorrência) é **mais curto** que o NSU 1 h — não protegia às 23:40Z.

`PRONTO_PARA_CONSULTA` = checks locais OK (**documentado no próprio serviço**); **não** implica aceitação SEFAZ.

### H5 — Falha de rastreabilidade — **CONFIRMADA** (limitação)

- `dfe_auditoria.empresa_id` e `central_entradas_eventos.empresa_id` frequentemente **null** (P0.10-B + coleta P0.13).
- Correlação P0.12 via CNPJ mascarado + `SYNC-20261018-204000-262` / texto `[empresa 1]`.
- CorrelationId da orquestração ≠ id da auditoria NSU (dois identificadores).

### H6 — Efeito colateral do boot — **INDÍCIO** (não causal do 656)

- P0.12: `database.js` executou ensure/`CREATE IF NOT EXISTS` no boot.
- **Não há evidência** de que isso tenha alterado NSU/cooldown antes do SOAP ou causado o 656.
- Efeito efetivo no esquema: **NÃO COMPROVADO** além do log de ensure (não se afirma “banco intacto” nem “alterado com impacto fiscal”).

---

## 7. Análise do tratamento de 656

| Requisito | Evidência |
|---|---|
| Preserva NSU | Sim — 196→196; `NSU_PRESERVADO` / `SEFAZ_NAO_MAIOR` |
| Cooldown único por resposta | Sim — `cooldown_ate = agora+1h` em `aplicarRetornoDistDfe` |
| Horário = recebimento | `data_sincronizacao` / `cooldown_ate` alinhados a 23:40:01Z |
| Retry automático | Não no fluxo DistDFe; P0.12 sem segunda chamada |
| `forcar` / `ignorarCooldown` liberam? | Código P0.11: **não** na sync/decisão |
| Bloqueio pós-656 em todos os caminhos? | NSU+Gate+decisão nos caminhos Centrais; probe diagnóstico é ressalva estática |
| Coerência decisão vs auxiliares | Decisão OR de NSU+Gate+mutex+rate; **não** modela “ult=max após 656” como fila SEFAZ |

---

## 8. Testes

**Não reexecutados nesta microsprint** (diagnóstico read-only; evitar boot/`database.js`).

Referência: P0.11 — 41 testes isolados aprovados (656 preserva NSU, mutex, decisão, gate fail-closed, etc.), sem SEFAZ real.

---

## 9. Limitações e evidências ausentes

- Estado interno da SEFAZ (timers reais) **não observável**.
- `SefazConsultaTrace` RAM não persistido.
- Evento `abrir_central` 22:31 “sucesso” sem breakdown por empresa → SOAP emp.1 **NÃO COMPROVADO**.
- Ausência de log ≠ ausência absoluta de cliente externo ao CDS.
- Coleta RO pode atrasar se houver WAL sujo de outro processo (no momento da coleta P0.13 o estado NSU/cooldown batia com P0.12).

---

## 10. Riscos (prioridade)

1. **P0 — Modelo local ≠ SEFAZ em `ult=max` após 656:** `PRONTO_PARA_CONSULTA` permite DistDFe que a SEFAZ classifica como consumo indevido.
2. **P0 — Mutex só intra-processo:** duas instâncias Electron poderiam concorrer (não ocorreu na P0.12).
3. **P1 — `empresa_id` nulo** em eventos/auditoria dificulta forense.
4. **P1 — BACKGROUND ainda agenda** ciclos (sem auth DistDFe, mas ruído operacional).
5. **P2 — Probe de diagnóstico** com possível fail-open residual no Gate.
6. **P2 — Dualidade Gate 10–120 min vs NSU 1 h** confunde operador.

---

## 11. Recomendações para microsprint corretiva (sem implementar agora)

1. Estender a decisão P0.11: se `ultNSU=maxNSU` e último resultado operacional foi 137/138/**656** com “sem documentos”, manter bloqueio local (`FILA_ESGOTADA` / novo código) até nova evidência de documentos **ou** janela explícita alinhada à NT — **sem** reduzir a 1 h do 656.
2. Não emitir `PRONTO_PARA_CONSULTA` quando o cursor estiver esgotado sem indício de novidade.
3. Preencher `empresa_id` em `dfe_auditoria` e eventos `SYNC_*`.
4. Unificar correlationId orquestração ↔ auditoria.
5. Documentar no UI: “liberado localmente ≠ SEFAZ aceitará”.
6. Próxima consulta real: **só com nova autorização**, após `cooldown_ate` atual (`00:40Z` / ~21:40 Fortaleza), preferir empresas 2/3 se elegíveis, **nunca** emp.1 durante cooldown; considerar que `ult=max` pode gerar novo 656 mesmo “liberado”.

**Não repetir DistDFe agora.**

---

## 12. Veredito

### **APROVADO COM RESSALVAS**

Ressalvas: causa SEFAZ profunda (timer interno) não instrumentável; lacunas de `empresa_id`/trace RAM; efeito do ensure no boot não quantificado.

**Causa raiz comprovada (engenharia local + evidência operacional):** a P0.12 consultou DistDFe com cursor `196/196` após 656 anterior; a decisão local considerou apenas expiração de `cooldown_ate`, enquanto a regra `FILA_ESGOTADA` não se reaplica com `ultimo_cstat=656`, e a SEFAZ rejeitou com 656 por consumo indevido na condição de ausência de documentos.

---

## 13. Confirmações de proteção (P0.13)

- Nenhuma operação fiscal remota nesta microsprint.
- Nenhuma alteração intencional de banco, NSU, flags ou cooldown.
- Nenhuma alteração de código de produto.
- Coleta RO apenas via procedimento P0.10-B (SELECT + OPEN_READONLY).
- Sem commit/push/merge.
