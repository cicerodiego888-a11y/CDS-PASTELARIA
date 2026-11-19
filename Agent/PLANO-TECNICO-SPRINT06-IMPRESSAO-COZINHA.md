# PLANO TÉCNICO — Sprint 06 · Impressão de Cozinha

**Projeto:** CDS Pastelaria — Módulo Cozinha  
**Brief:** Impressão de Cozinha (objetivo aprovado pelo Product Owner)  
**Responsável implementação:** Cursor  
**Arquitetura / validação:** Tech Lead  
**Status:** PLANO APROVADO PELO TECH LEAD · **Blocos A + B + C entregues (C aguardando auditoria)** · Blocos D–E não iniciados

---

## 0. Premissas da inspeção (somente leitura)

### 0.1 Schema já existente (reutilizar)

`backend/utils/cozinhaSchema.js` (schema Cozinha **v3**):

**`cozinha_estacoes_impressao`**
- `empresa_id`, `unidade_id`, `codigo_estacao` (UNIQUE por empresa)
- `device_name` (nome da impressora no SO / Electron)
- `largura_mm` ∈ {58, 80} — default **80**
- `vias` (> 0), `modelo_individual`, `modelo_agrupado`, `ativo`
- FK composta `(unidade_id, empresa_id)` → `cozinha_unidades`

**`cozinha_impressao_fila`**
- `empresa_id`, `unidade_id`, `estacao_impressao_id`, `rodada_id`
- `payload_snapshot` (TEXT JSON)
- `modelo` ∈ {`INDIVIDUAL`, `AGRUPADO`}
- `vias`, `estado` ∈ {`PENDENTE`, `PROCESSANDO`, `RESULTADO_INCERTO`, `ACEITA_PELO_SPOOLER`, `FALHA`, `CANCELADA`}
- `tentativas`, `max_tentativas` (default 5), `ultimo_erro`
- `job_origem_id` (auto-FK para reenvio), `spooler_job_token`, `processando_em`, `worker_id`
- `idempotency_key` **UNIQUE** global na fila
- FKs compostas para rodada, unidade, estação

**Lacuna estrutural relevante:** não há tabela/coluna de roteamento item→estação.  
`cozinha_itens.tipo_item` ∈ {`PASTEL`, `BEBIDA`, `OUTRO`} já existe e será a base do direcionamento proposto (sem tabela duplicada).

### 0.2 O que NÃO reutilizar como motor de cozinha

| Artefato | Motivo |
|---|---|
| `configuracoes.impressora_cupom` | Impressão comercial/fiscal |
| `POST /api/impressao/*` | Cupom / TEF / Electron cupom |
| `frontend/shared/js/fiscalImpressao.js` | DANFE / fiscal |
| `ComprovantePrintService` (MUV) | Comprovante de atendimento |
| `ThermalPrintAdapter` (MUV) | Stub de comprovante (`impressao_fisica: false`); domínio diferente |

### 0.3 Ambiente Electron encontrado

- `electron-common.js`: `webContents.print({ silent, deviceName })` e listagem `getPrintersAsync`.
- Compatível com o padrão “job → HTML/TEXT → silent print por `deviceName`”.
- A Cozinha usará o **mesmo mecanismo de SO**, com **device e fila próprios**, sem ler `impressora_cupom`.

### 0.4 Fluxo Cozinha homologado (S01–S05) a preservar

Despacho (`CozinhaDespachoService`) → rodada/itens/FIFO/idempotência.  
Preparação (`CozinhaPreparacaoService`) → iniciar/pronto/bebida.  
Unidade autenticada no JWT (S05).  
**Falha de impressão jamais altera** estados de preparação, rodada, pedido ou FIFO.

---

## 1. Arquitetura proposta

```
┌─────────────────────┐     mesma TX do despacho      ┌──────────────────────────┐
│ CozinhaDespacho     │  ──enfileira jobs (PENDENTE)─▶ │ cozinha_impressao_fila   │
│ Service (S02)       │     NÃO executa print físico  │ + payload_snapshot       │
└─────────────────────┘                               └────────────┬─────────────┘
                                                                   │
                     claim atômico PENDENTE→PROCESSANDO            │
                                                                   ▼
┌─────────────────────┐   render 58/80   ┌──────────────────────────┐
│ CozinhaImpressao    │◀────────────────│ CozinhaPrintRenderer     │
│ Worker (Electron)   │                 │ (TEXT/HTML cozinha)      │
└─────────┬───────────┘                 └──────────────────────────┘
          │ silent print(device_name da estação)
          ▼
┌─────────────────────┐
│ Spooler SO / térmica│  → ACEITA_PELO_SPOOLER | FALHA | RESULTADO_INCERTO
└─────────────────────┘
          │
          ✗ nunca → UPDATE cozinha_itens / rodadas.estado_preparacao / pedidos
```

### Princípios

1. **Fila = fonte de verdade** do trabalho de impressão (já modelada no S01).
2. **Enfileirar ≠ imprimir.** Despacho só grava jobs `PENDENTE` (+ snapshot). Execução é assíncrona.
3. **Isolamento:** job sempre carrega `empresa_id` + `unidade_id` + estação da mesma empresa/unidade.
4. **Idempotência da fila:** `cozinha_impressao_fila.idempotency_key` UNIQUE (já existe) — chave canônica do job.
5. **Idempotência HTTP** (reenvio / teste / CRUD estação): reutilizar padrão S02/S05 com `Idempotency-Key` + hash; **sem** misturar com cupom/TEF.
6. **Vendor-neutral:** porta de saída = `device_name` do SO (Electron). Sem SDK de fabricante na S06.
7. **80 mm padrão; 58 mm** via `largura_mm` da estação (já no CHECK).

### Decisão de schema (proposta)

| Tema | Proposta | Motivo |
|---|---|---|
| Novas tabelas | **Não** | Reutilizar `cozinha_estacoes_impressao` + `cozinha_impressao_fila` |
| Bump schema v3→v4 | **Evitar na S06**, se possível | CHECK de `cozinha_idempotencia` não inclui tipos de impressão |
| Idempotência impressão | Primária na **fila** (`idempotency_key`); HTTP de reenvio usa chave derivada estável | Evita migration S04A-like |
| Tipos no central | Opcional / fase 2 se Tech Lead exigir | Só com upgrade controlado do CHECK |
| Outbox | Evento `IMPRESSAO_ENFILEIRADA` / `IMPRESSAO_FALHA` na mesma TX do enfileiramento, se útil para auditoria | Não implica SSE/KDS (fora de escopo) |

**Ponto para o Tech Lead:** confirmar se S06 pode permanecer em schema **v3** com idempotência na fila, ou se exige tipos novos em `cozinha_idempotencia` (implica plano de upgrade v4).

---

## 2. Fluxo completo de impressão

### 2.1 Cadastro de estação

1. Operador autorizado (empresa + unidade da sessão) cria/edita estação.
2. Campos: `codigo_estacao`, `device_name`, `largura_mm` (80|58), `vias`, flags `modelo_individual` / `modelo_agrupado`, `ativo`.
3. Listagem de impressoras do SO (Electron) é auxiliar de UI — não grava em `impressora_cupom`.

### 2.2 Direcionamento (proposta sem tabela nova)

Regra S06 (default):

| `tipo_item` do item | Estação alvo |
|---|---|
| `PASTEL` | Estação ativa da unidade com `codigo_estacao = 'PASTEL'` (ou configurada como padrão pastel) |
| `BEBIDA` | `codigo_estacao = 'BEBIDA'` |
| `OUTRO` | `codigo_estacao = 'OUTRO'` ou fallback da unidade |

Se a estação correspondente estiver inativa/ausente → job ainda é criado com `estado=FALHA` **ou** `PENDENTE` sem `estacao_impressao_id`?  

**Proposta:** criar job `PENDENTE` com estação resolvida; se não houver estação → `FALHA` imediata com `ultimo_erro=ESTACAO_NAO_CONFIGURADA`, **sem** alterar preparação. Assim a operação fica visível e reenviável após cadastro.

**Ponto para o Tech Lead/PO:** validar convenção `codigo_estacao` ↔ `tipo_item` vs. mapeamento explícito futuro.

### 2.3 Enfileiramento no despacho

Após validações e **antes do COMMIT** do `despacharLote` (mesma `BEGIN IMMEDIATE`):

1. Agrupar itens da rodada por estação resolvida.
2. Para cada grupo, conforme flags da estação:
   - `AGRUPADO`: 1 job por (rodada, estação) com todos os itens do grupo.
   - `INDIVIDUAL`: 1 job por comanda (ou por item — ver decisão §8) na estação.
3. Gerar `idempotency_key` estável, ex.:  
   `imp:{empresa}:{unidade}:{rodada}:{estacao}:{modelo}:{escopo}`  
   (escopo = `all` | `comanda:{id}`).
4. `INSERT` em `cozinha_impressao_fila` com `estado=PENDENTE`, `payload_snapshot` imutável (mesa, sequência, itens, ingredientes, obs — **sem preços/fiscais**).
5. `vias` copiadas da estação no momento do enfileiramento.
6. COMMIT do despacho inclui os jobs.  
   Replay do despacho (mesma Idempotency-Key) **não** cria nova rodada nem novos jobs.

Alinhamento ao contrato: *“Print ≠ gravação”* = o print **físico** é pós-commit (worker); a **gravação do job** é atômica com o despacho (recuperável se o processo cair).

### 2.4 Execução (worker)

1. Worker local (Electron) lista/claim jobs `PENDENTE` da(s) estação(ões) locais (`device_name` + unidade).
2. Claim atômico: `PENDENTE` → `PROCESSANDO` com `worker_id`, `processando_em`, `tentativas++` (só se `tentativas < max_tentativas`).
3. Render do `payload_snapshot` conforme `largura_mm`.
4. Para cada via (1..N): envio silent print ao `device_name`.
5. Sucesso spooler → `ACEITA_PELO_SPOOLER` (+ `spooler_job_token` se disponível).  
   **ACEITA ≠ garantia de papel físico** (já no contrato).
6. Falha conhecida → `FALHA` + `ultimo_erro`.
7. Timeout / processo morto no meio → watchdog marca `RESULTADO_INCERTO` (não assume sucesso; permite inspeção/reenvio controlado).

### 2.5 Reenvio

1. `POST .../impressao/:id/reenviar` somente se estado ∈ {`FALHA`, `RESULTADO_INCERTO`} (e opcionalmente `CANCELADA` — **não** por padrão).
2. Cria **novo** job com:
   - `job_origem_id = id` original
   - nova `idempotency_key` estável: `imp:reenvio:{job_origem_id}:{n}` **ou** Idempotency-Key do cliente
   - mesmo `payload_snapshot` (ou regenerado só se TL autorizar — default: **mesmo snapshot**)
3. Job original permanece como histórico (`FALHA`); não é “resetado” para `PENDENTE` (evita corrida e perda de histórico).
4. Reenvio **nunca** altera `cozinha_itens` / rodada / pedido.

### 2.6 Consulta operacional

- Listar jobs por empresa/unidade/estado (`PENDENTE` / `PROCESSANDO` / `ACEITA_PELO_SPOOLER` / `FALHA` / `RESULTADO_INCERTO`).
- Detalhe do job + vínculo à rodada/estação.
- Contadores simples por estado (API; UI mínima fora do escopo KDS).

---

## 3. Reaproveitamento das tabelas existentes

| Necessidade do brief | Estrutura | Ação S06 |
|---|---|---|
| Fila persistente | `cozinha_impressao_fila` | Serviço + worker |
| Estações | `cozinha_estacoes_impressao` | CRUD API |
| Vias / 58/80 | colunas `vias`, `largura_mm` | Usar no enfileiramento e render |
| Modelos individual/agrupado | `modelo_*` + `modelo` no job | Usar |
| Histórico | própria fila + `job_origem_id` | Sem tabela nova |
| Tentativas / reenvio | `tentativas`, `max_tentativas`, `job_origem_id` | Worker + API reenviar |
| Indisponível | `FALHA` / `RESULTADO_INCERTO` | Sem cancelar pedido |
| Anti-duplicação | `UNIQUE(idempotency_key)` | Chaves estáveis |
| Direcionamento | `tipo_item` + `codigo_estacao` | Convenção (sem tabela nova) |
| Snapshot | `payload_snapshot` | Conteúdo canônico no enfileiramento |

**Não criar** `cozinha_impressao_historico` separado: o histórico é a própria fila + cadeia `job_origem_id`.

---

## 4. Estratégia de comunicação com impressoras

### 4.1 Camada de domínio (backend Node)

Novos módulos (propostos):

| Módulo | Responsabilidade |
|---|---|
| `CozinhaImpressaoEstacaoService` | CRUD estações; validar unidade/empresa; listar |
| `CozinhaImpressaoFilaService` | Enfileirar no despacho; listar; claim; concluir; falhar; reenviar |
| `CozinhaImpressaoRenderer` | Montar conteúdo TEXT/HTML 80/58 a partir do snapshot |
| `CozinhaImpressaoDriver` | Porta abstrata `imprimir({ deviceName, conteudo, larguraMm, vias })` |
| `CozinhaImpressaoWorker` | Loop/claim no processo Electron (ou endpoint “processar próximo” chamado pelo Electron) |

### 4.2 Porta física (Electron)

- **S06:** `BrowserWindow` oculto + `webContents.print({ silent: true, deviceName })`, espelhando o padrão já usado em `electron-common.js`, **sem** ler `impressora_cupom`.
- Driver recebe só `device_name` da estação Cozinha.
- Listagem: `getPrintersAsync()` para auxiliar configuração de estação.
- ESC/POS USB direto (`escpos` do TEF) **fora** da S06 como caminho padrão (acopla fabricante/USB); pode ser evolução se PO exigir, atrás da mesma porta `CozinhaImpressaoDriver`.

### 4.3 Independência comercial/fiscal

- Zero dependência de rotas `/api/impressao`.
- Zero escrita em `impressora_cupom`.
- Conteúdo sem preços, totais, NFC-e, DANFE, TEF.
- Prefixo de IPC/API dedicado: `/api/cozinha/impressao/*` e, se necessário, `electronAPI.cozinhaImprimir` (nome distinto).

---

## 5. Contratos dos serviços

### 5.1 Estações

| Método | Rota | Contrato |
|---|---|---|
| GET | `/api/cozinha/impressao/estacoes` | Lista por empresa + filtro unidade |
| POST | `/api/cozinha/impressao/estacoes` | Cria estação (unidade da sessão ou autorizada) |
| PUT | `/api/cozinha/impressao/estacoes/:id` | Atualiza config / ativo / device_name / vias / modelos / largura |
| POST | `/api/cozinha/impressao/estacoes/:id/teste` | Enfileira ou executa job de teste (não ligado a rodada real — ver §8) |

Auth: token + contexto empresa + unidade operacional (padrão S05).

### 5.2 Fila

| Método | Rota | Contrato |
|---|---|---|
| GET | `/api/cozinha/impressao/fila` | Filtros: unidade, estado, rodada_id |
| GET | `/api/cozinha/impressao/fila/:id` | Detalhe + origem de reenvio |
| POST | `/api/cozinha/impressao/fila/:id/reenviar` | Header `Idempotency-Key`; cria job filho |
| POST | `/api/cozinha/impressao/fila/:id/cancelar` | Só `PENDENTE` → `CANCELADA` (opcional S06) |

### 5.3 Worker / execução

| Método | Rota (interna/local) | Contrato |
|---|---|---|
| POST | `/api/cozinha/impressao/worker/claim` | Claim próximo `PENDENTE` da estação/unidade |
| POST | `/api/cozinha/impressao/worker/:id/resultado` | `ACEITA_PELO_SPOOLER` \| `FALHA` \| `RESULTADO_INCERTO` |

Alternativa: worker embutido no Electron chamando serviços locais sem HTTP público — preferível para não expor claim na LAN; detalhar na implementação após aprovação.

### 5.4 Integração despacho

- Extensão mínima de `CozinhaDespachoService.despacharLote`: após INSERT dos itens, chamar `CozinhaImpressaoFilaService.enfileirarDaRodada(...)` **dentro da mesma TX**.
- Replay idempotente do despacho: não re-enfileira (jobs já existem / mesma key).
- Falha ao enfileirar (ex.: constraint) → **ROLLBACK** do despacho inteiro (consistência).  
  Falha **física** de impressora ocorre só no worker, pós-commit → **não** reverte despacho.

### 5.5 Conteúdo do `payload_snapshot` (canônico)

```json
{
  "empresa_id": 1,
  "unidade_id": 1,
  "rodada_id": 10,
  "sequencia_global": 42,
  "mesa_numero": "12",
  "atendimento_id": 5,
  "numero_rodada": 2,
  "enviada_em": "...",
  "modelo": "AGRUPADO",
  "largura_mm": 80,
  "itens": [
    {
      "cozinha_item_id": 1,
      "comanda_id": 3,
      "tipo_item": "PASTEL",
      "descricao": "...",
      "qty": "2.000",
      "observacao": "...",
      "ingredientes": [{ "nome": "...", "qty": "1.000", "selecionado": true }]
    }
  ]
}
```

Sem preço, CPF, forma de pagamento, fiscal.

### 5.6 Códigos de erro (proposta)

| Código | Uso |
|---|---|
| `ESTACAO_NAO_ENCONTRADA` | CRUD / roteamento |
| `ESTACAO_INATIVA` | Enfileiramento / teste |
| `IMPRESSAO_JOB_NAO_ENCONTRADO` | Get/reenvio |
| `IMPRESSAO_ESTADO_INVALIDO` | Reenvio em estado não elegível |
| `IMPRESSAO_IDEMPOTENCY_DIVERGENTE` | Mesma key, payload diferente |
| `IMPRESSAO_DEVICE_INDISPONIVEL` | Worker / teste |
| `UNIDADE_ISOLAMENTO` / `EMPRESA_*` | Reutilizar padrões S05 |

---

## 6. Plano de testes

Banco: **somente temporário** (`os.tmpdir` + `CDS_BLOQUEAR_BANCO_OFICIAL=1`).  
Execução sequencial. Sem tocar instalação do cliente.

### 6.1 Fundação / contratos

1. CRUD estação na unidade autorizada.
2. Rejeitar estação de outra empresa/unidade.
3. `largura_mm` 58 e 80 aceitos; outros rejeitados.
4. Snapshot sem campos fiscais/preço.

### 6.2 Fila e idempotência

5. Despacho cria N jobs conforme estações/modelos.
6. Replay despacho (mesma Idempotency-Key) não duplica jobs.
7. `idempotency_key` duplicada na fila → rejeição / replay seguro.
8. Job permanece `PENDENTE` após despacho (sem worker).

### 6.3 Estações e direcionamento

9. PASTEL → estação PASTEL; BEBIDA → BEBIDA.
10. Itens de tipos distintos geram jobs em estações distintas.
11. Estação ausente → falha de impressão documentada **sem** desfazer despacho (se enfileiramento pós-resolução) **ou** política aprovada no §8.

### 6.4 Execução e falhas

12. Claim PENDENTE→PROCESSANDO atômico (dois workers → um ganha).
13. Sucesso → `ACEITA_PELO_SPOOLER`; preparação do item **inalterada**.
14. Driver simulando indisponível → `FALHA`; rodada/itens intactos.
15. Esgotamento de `max_tentativas` permanece `FALHA` recuperável por reenvio.
16. Watchdog / claim órfão → `RESULTADO_INCERTO`.

### 6.5 Reenvio

17. Reenvio de `FALHA` cria job filho com `job_origem_id`.
18. Mesma Idempotency-Key de reenvio → não duplica.
19. Reenvio de `ACEITA_PELO_SPOOLER` rejeitado (salvo decisão PO).

### 6.6 Isolamento e regressão

20. Isolamento empresa/unidade nos endpoints de impressão.
21. Regressão S01–S05 (suites existentes) — `TOTAL_FAIL=0`.
22. Garantir que `/api/impressao` e `impressora_cupom` **não** são lidos/escritos pelos testes S06.

### 6.7 Driver Electron

23. Teste com driver **fake** (obrigatório em CI).  
24. Teste de integração Electron (manual/homologação) — marcado como evidência opcional nesta sprint automatizada.

---

## 7. Divisão das etapas de implementação

Cada bloco só começa após aceite do anterior (e após **este plano** aprovado).

### Bloco A — Fundação e contratos
**Objetivo:** serviços de estação + contratos HTTP + renderer de snapshot (sem print físico).  
**Aceite:** CRUD estação testado; snapshot canônico; zero acoplamento a cupom/TEF.

### Bloco B — Fila persistente e idempotência
**Objetivo:** `enfileirarDaRodada` no despacho (mesma TX); keys estáveis; listagem de fila.  
**Aceite:** despacho cria jobs; replay não duplica; regressão S02 despacho verde.

### Bloco C — Estações e direcionamento
**Objetivo:** resolução tipo_item→estação; modelos INDIVIDUAL/AGRUPADO; vias no job.  
**Aceite:** testes 9–11; jobs por estação corretos.

### Bloco D — Execução e falhas
**Objetivo:** worker/claim/resultado; driver abstrato + fake; reenvio; estados da máquina.  
**Aceite:** testes 12–19; falha de print não mexe preparação.

### Bloco E — Integração, Electron e regressão
**Objetivo:** ponte Electron (`deviceName`); teste de impressão de estação; suite S06 + regressão S01–S05.  
**Aceite:** logs `TOTAL_FAIL=0`; declaração de banco temporário; pacote de auditoria S06.

**Fora de todos os blocos (confirmado pelo brief):** KDS, Android, notificações garçom, retirada, entrega, PDV, fiscal, TEF, PIX, rebuild da impressão comercial.

---

## 8. Decisões que precisam do Tech Lead / PO antes do código

| # | Decisão | Opções | Impacto |
|---|---|---|---|
| D1 | Idempotência HTTP de impressão no central `cozinha_idempotencia`? | (a) Só UNIQUE da fila (sem v4) · (b) Upgrade schema v4 com tipos novos | Migration |
| D2 | Momento do enfileiramento | (a) Mesma TX do despacho (recomendado) · (b) Após COMMIT via outbox | Recuperação vs. atomicidade |
| D3 | Convenção de roteamento | (a) `codigo_estacao` = `tipo_item` · (b) campo/mapa futuro | Escopo schema |
| D4 | Modelo INDIVIDUAL = por comanda ou por item? | Comanda (alinhado ao contrato) vs item | Volume de jobs |
| D5 | Sem estação configurada | Job `FALHA` imediata vs bloquear despacho | Operação do salão |
| D6 | Job de teste de estação | Linha na fila com `rodada_id` sintético **não** — exige FK real · alternativa: execução direta sem fila **ou** rodada de teste em banco temp only | FK `rodada_id NOT NULL` |
| D7 | Worker via HTTP claim vs só IPC Electron | Segurança LAN | Superfície de ataque |
| D8 | Reenvio de `ACEITA_PELO_SPOOLER` (2ª via manual) | Permitir com nova key vs negar | Operação |

**Recomendações do Cursor (sujeitas a veto do TL):**  
D1=a · D2=a · D3=a · D4=comanda · D5=`FALHA` sem rollback do despacho **se** a estação era esperada mas ausente **após** commit… *corrigindo:* com D2=a, ausência de estação no enfileiramento deve ser política explícita — **recomendação refinada D5:** se nenhuma estação ativa na unidade → despacho **segue** e **não** cria jobs (log/outbox `IMPRESSAO_SEM_ESTACAO`); se tipo específico sem estação → job não criado para aquele grupo + evento de auditoria (não falha o despacho). Impressão nunca bloqueia salão.  
D6=execução direta de teste (fora da fila) **ou** endpoint que só valida device sem INSERT.  
D7=IPC Electron / local-only.  
D8=negar por padrão; PO pode liberar depois.

---

## 9. Riscos e limites conscientes

- `ThermalPrintAdapter` MUV **não** imprime de fato hoje; Cozinha não dependerá dele.
- `ACEITA_PELO_SPOOLER` ≠ papel na gaveta (contrato).
- Sem UI KDS nesta sprint — operação via API + worker.
- FK `rodada_id NOT NULL` impede jobs órfãos “só teste” na fila sem rodada — tratar teste de impressora fora da fila ou com fixture de rodada só em teste.
- Não alterar S01–S05 homologados além do gancho mínimo de enfileiramento no despacho.

---

## 10. Entregáveis quando a implementação for autorizada

1. Diff real por bloco.  
2. Testes S06 + regressão S01–S05.  
3. Pacote `Agent/auditoria-sprint06-impressao/`.  
4. Declaração de banco temporário.  
5. Evidência de isolamento vs impressão comercial.

---

## Condição desta entrega

**PLANO TÉCNICO S06 APRESENTADO — AGUARDANDO APROVAÇÃO DO TECH LEAD.**

Nenhum código de Sprint 06 foi escrito.  
Nenhuma migration executada.  
Banco oficial intocado.  
Implementação **bloqueada** até aprovação explícita deste plano (e fechamento das decisões D1–D8 necessárias).
