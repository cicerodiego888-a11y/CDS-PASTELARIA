# Correção — Central não localiza NF-e do mês

**Prioridade:** P0  
**Data:** 17/10/2026  
**Prazo do projeto:** 25/10/2026  
**Escopo:** diagnosticar por que a Central não exibe NF-e esperadas do mês vigente e corrigir as causas comprovadas em código, sem consulta real à SEFAZ.  
**Resultado:** causas internas comprovadas e corrigidas em isolado. DistDFe real **não** foi homologado.

Esta etapa **não** declara que a consulta operacional à SEFAZ está GO.

---

## 1. Branch, HEAD e preservação

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| Subject | `implemetação Diversas` |

Alterações preexistentes **preservadas** (sem commit, push, merge ou comando destrutivo de Git):

- Microsprints 2.6 / 2.7 / 2.8 e homologação operacional parcial
- Fiscal / vendas / faturamento e testes de cancelamento NFC-e
- `docs/bancario/OF-01-AUDITORIA-ITAÚ.md`

Não houve `git reset`, `checkout` destrutivo, `clean`, commit, push ou merge.  
`empresaId` permanece obrigatório. Não há fallback global de empresa.  
NSU **não** foi zerado nem retrocedido automaticamente.  
Manifestação **210210** não foi alterada.

---

## 2. Isolamento e ausência de SEFAZ

| Controle | Evidência |
|---|---|
| Banco das suítes | SQLite `:memory:` e `DB_DIR` em `%TEMP%\cds-nfe-*` |
| Oficial | `C:\ProgramData\MercantilFiscal\dados` **não** foi aberto |
| DistDFe | mocks (`enviarDistribuicaoDfe`, XML local gzip) |
| Certificado de produção | não utilizado |
| `CDS_FORCAR_LOCAL` | `1` |

O banner interno `BANCO OFICIAL EM USO` apareceu em alguns loaders, mas o caminho observado foi temporário (`...\Temp\cds-nfe-*\mercadao.db`), não `ProgramData`.

Não houve consulta, manifestação nem transmissão real à SEFAZ.

---

## 3. Fase 1 — Diagnóstico

Pontos inspecionados: `CentralNsuService.js`, `CentralSincronizacaoService.js`, `distribuicaoDFe.js`, `CentralSyncExecucaoService.js`, `CentralDfePersistenciaService.js`, filtros (`CentralPeriodoPadraoService` / `filtrosRapidosCentral` / `CentralDocumentosRepository.listar`), UI (`frontend/erp/js/central-entradas.js`).

### 3.1 Quando a consulta é executada, bloqueada ou ignorada

| Situação | Comportamento observado (antes) | Comportamento após correção |
|---|---|---|
| `cooldownAte` vigente | DistDFe **não** envia; resultado podia ir como `sucesso: true` | `consultaExecutada: false`, `ignorado: true`, `sucesso: false`, código `AGUARDAR_JANELA_DFE`, motivo `COOLDOWN_EXPLICITO` |
| `ultNSU = maxNSU` + última sync < 1 h **e** `ultimoCstat` 137/138 | DistDFe **não** envia; tratado como fila esgotada | mesmo bloqueio, motivo **`FILA_ESGOTADA`** (somente 137/138) |
| `ultNSU = maxNSU` após **falha** (ex.: 656 sem `cooldownAte`) | podia herdar o cooldown de “fila esgotada” | **não** usa `FILA_ESGOTADA`; 656 só bloqueia via `cooldownAte` (`COOLDOWN_EXPLICITO`) |
| Gate SEFAZ negar | DistDFe **não** envia | `consultaExecutada: false`, `ignorado: true`, `bloqueadoGate: true` |
| DistDFe HTTP/SOAP falha | exception; NSU não avança | inalterado: não vira sucesso; NSU preservado |
| Lote persistido OK (137/138) | avança `ultNSU`/`maxNSU` (nunca regride) | inalterado |

Em **MULTIEMPRESA**, o cooldown global de `CentralSyncExecucaoService.executar()` **não** bloqueia o lote inteiro. O bloqueio correto é **por CNPJ** em `CentralSincronizacaoService._sincronizarEmpresa`. O teste RC3.3 foi realinhado a essa camada.

### 3.2 Sucesso enganoso

**Causa A (primeira perda operacional na UI):** sincronização ignorada por cooldown/Gate era agregada como `sucesso: true` (“Sincronização concluída”) quando todas as empresas eram puladas e não havia `errosPersistencia`. A UI mostrava *“Sincronização concluída. Nenhuma nota nova.”*

Isso induz o operador a crer que DistDFe **rodou** e a SEFAZ **não tinha** a NF-e do mês. Na prática a consulta **não foi executada**.

**Causa B (perda irreversível do lote):** falha SQLITE/BUSY em `persistirDocumentoDfe` incrementava `ignorados` (classe 05.43) e, com lote “processado”, `aplicarRetornoDistDfe` avançava o NSU. A SEFAZ **não reenvia** o mesmo NSU. O documento desaparecia sem ficar na lista.

### 3.3 Avanço de NSU e persistência

Regra preservada: `ultNSU`/`maxNSU` nunca regridem; zeros após progresso são rejeitados; cStat 656 não avança NSU por esta via.

Após a correção, `aplicarRetornoDistDfe` **só** ocorre se `errosPersistencia.length === 0`. Persistência incompleta devolve `PERSISTENCIA_DFE_INCOMPLETA` com o NSU **local** inalterado, permitindo retomada idempotente (chave + `empresa_id`).

### 3.4 Filtros de lista (data, empresa, status)

| Filtro | Evidência | Ação |
|---|---|---|
| `MES_VIGENTE` (`data_emissao` no mês corrente) | inclui outubro/2026 e **exclui** setembro — comportamento correto | **não** alargado |
| `data_emissao` NULL/vazio | `listar` exige `data_emissao IS NOT NULL`; XML sem `dhEmi` sumia do mês vigente | preenchimento `YYYY-MM-01` a partir do AAMM da chave |
| `empresaId` | empresa B não vê documento da empresa A (`UNIQUE(chave, empresa_id)`) | isolamento preservado; filtro **não** removido |
| Status RC3.7.1 | sem evidência de ocultar NF-e recém-persistida neste diagnóstico | **não** alterado |

### 3.5 CNPJ e ambiente fiscal

Não houve leitura do certificado de produção nem chamada DistDFe real. CNPJ/ambiente da empresa operacional **não** foram comprovados contra a SEFAZ nesta etapa.

Se o contexto fiscal (CNPJ ou ambiente homologação vs produção) estiver errado, DistDFe real pode devolver 137/fila vazia mesmo com correções internas. Isso permanece **não homologado**.

### 3.6 Primeira etapa em que o documento deixa de aparecer

Ordem comprovada em código (a primeira que ocorrer encerra o fluxo):

1. **Consulta não executada** (cooldown `FILA_ESGOTADA` / `COOLDOWN_EXPLICITO` ou Gate) — UI dizia sucesso. **Esta é a causa mais frequente do sintoma “não achei a nota do mês” quando o operador clica em sincronizar várias vezes na mesma hora.**
2. **Consulta executada, persistência falha, NSU avança** — lote perdido; DistDFe não reenvia. **Causa de ausência permanente** até recuperação manual (proibida de zerar NSU automaticamente).
3. **Documento persistido com `data_emissao` vazia** — filtro do mês vigente oculta. Corrigido na ingestão.
4. **Documento de outra empresa / outro mês / outro status de fila** — filtro correto, não é bug de DistDFe.
5. **NSU local já passou do lote histórico** — DistDFe não devolve de novo. Sem rewind automático; exige DistDFe autorizado ou recuperação pontual por chave.

---

## 4. Causa comprovada (síntese)

Não há evidência, nesta etapa, de que a lista “esconda” NF-e já gravadas do mês vigente **quando** `data_emissao` e `empresa_id` estão corretos.

Há evidência de dois defeitos de **resultado e persistência**:

1. **Consulta ignorada era apresentada como consulta concluída sem notas novas.**
2. **Falha de persistência era contada como `ignorado` e permitia avançar NSU**, perdendo o lote.

Filtro mensal só ocultava documento **já recebido** quando `data_emissao` vinha vazia (XML sem `dhEmi`). Isso foi corrigido na persistência, sem mudar a janela `MES_VIGENTE`.

A ausência da NF-e **na SEFAZ para aquele CNPJ/ambiente**, ou NSU já avançado historicamente, **não** pode ser afirmada nem negada sem DistDFe autorizado.

---

## 5. Fase 2 — Correção

### 5.1 Resultado enganoso de sincronização ignorada

- DTO: `consultaExecutada`, `ignorado`, `motivoIgnorado`, `errosPersistencia`, `codigo`.
- Cooldown/Gate: `sucesso: false`, `consultaExecutada: false`, `ignorado: true`.
- Agregado multiempresa: `sucesso` só se **alguma** consulta rodou **e** persistiu sem erro. Se todas foram ignoradas: mensagem “Consulta DF-e não executada…”, código `AGUARDAR_JANELA_DFE`.
- Evento de sync ignorada: resultado `ignorado`, não `SYNC_ERRO` nem “sucesso vazio”.
- UI: aviso (`warning`), não *“Nenhuma nota nova”*.
- Orquestrador: `processarDocumentosPendentes` após sync só se `sucesso && !ignorado`.

### 5.2 Cooldown: fila esgotada ≠ falha de consulta

`FILA_ESGOTADA` exige `ultNSU = maxNSU` **e** `ultimoCstat` ∈ {137, 138}.

Falha 656 (e equivalentes) **não** entra nesse cooldown. Usa apenas `cooldownAte` (`COOLDOWN_EXPLICITO`), preenchido pelo fluxo DistDFe/Gate já existente.

Janela de 1 hora, rate limiter, circuit breaker e Gate **preservados**.

### 5.3 Persistência: sem perda silenciosa

- Até 2 tentativas em erro de banco (não estrutural).
- Erro restante vai para `errosPersistencia`, **não** para `ignorados`.
- `ignorados` permanece só para skip sem chave / sem efeito.
- Se houver `errosPersistencia`, DistDFe **não** chama `aplicarRetornoDistDfe`.
- Retorno: `PERSISTENCIA_DFE_INCOMPLETA`, `consultaExecutada: true`, NSU local preservado.
- Retomada: mesmo NSU; `persistirDocumentoDfe` é idempotente por `(chave, empresa_id)`.

### 5.4 Filtros

Não foram alargados. Única correção de ingestão: `completarDataEmissaoFromChave` (`YYYY-MM-01` a partir do AAMM da chave de 44 dígitos).

### 5.5 O que não foi feito (de propósito)

- Não zerar / retroceder NSU.
- Não alterar 210210.
- Não consultar SEFAZ real.
- Não usar certificado de produção.
- Não alterar estado fiscal real.

---

## 6. Arquivos desta etapa

| Arquivo | Papel |
|---|---|
| `backend/motores/central-entradas/contracts/SincronizacaoResultadoDTO.js` | Contrato `consultaExecutada` / `ignorado` / `errosPersistencia` |
| `backend/motores/central-entradas/services/CentralNsuService.js` | `FILA_ESGOTADA` só com cStat 137/138 |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Cooldown/Gate não-sucesso; agregado honesto |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | Mesmo contrato no `executar()`; evento `ignorado` |
| `backend/services/fiscal/distribuicaoDFe.js` | Retry, `errosPersistencia`, hold de NSU |
| `backend/motores/central-entradas/services/CentralDfePersistenciaService.js` | `data_emissao` a partir da chave |
| `frontend/erp/js/central-entradas.js` | Aviso de consulta não executada |
| `tests/central-entradas/nfe-nao-localizada-sync.test.js` | Suíte isolada desta correção |
| `tests/central-entradas/rc33-fechamento-ciclo-dfe.test.js` | Cooldown por CNPJ (não depende do modo global) |
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | Persistência falha ≠ `ignorados` |
| `docs/central-entradas/correcao-nfe-nao-localizada-relatorio.md` | Este relatório |

Gate (`CentralSefazOperationalGate`), filas, rate limiter e isolamento multiempresa **não** foram desligados.

---

## 7. Testes

Isolamento: `DB_DIR` temporário + `CDS_FORCAR_LOCAL=1`. Sem SEFAZ, sem cert de produção.

### 7.1 Suíte nova — `nfe-nao-localizada-sync.test.js`

`node --test tests/central-entradas/nfe-nao-localizada-sync.test.js` → **9 passou, 0 falhou**.

| Caso | Resultado |
|---|---|
| `FILA_ESGOTADA` só com 137/138; 656 sem `cooldownAte` não bloqueia | OK |
| Sync em cooldown não se apresenta como consulta concluída | OK |
| Falha de consulta DistDFe (ECONNRESET) não avança NSU e não vira sucesso | OK |
| Erro de persistência não conta como ignorado e não avança NSU | OK |
| Retomada idempotente persiste na 2ª tentativa | OK |
| Duplicata na mesma empresa não cria segundo documento | OK |
| Empresa B não vê documento da empresa A | OK |
| Mês vigente inclui outubro/2026 e exclui setembro | OK |
| XML sem `dhEmi` recebe data da chave | OK |

### 7.2 Suítes existentes (reexecutadas nesta etapa)

| Suíte | Resultado |
|---|---|
| `tests/central-entradas/rc33-fechamento-ciclo-dfe.test.js` | **11 passou; 0 falhou** |
| `npm run test:central-entradas-04` (Gate) | **21 ok, 0 falha** |
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | **8 ok, 0 falhou** |
| `npm run test:central-entradas` (execução anterior da mesma correção de produção, antes só do ajuste do teste RC3.3) | **exit 0** — máquina 11, s2 8, s4 5, s5 7, s7 11, s8 8, s9 7, s10 7, rc1 9, rc2 9 |

O RC3.3 falhou uma vez porque `executar()` em MULTIEMPRESA não aplica cooldown global. O caso foi movido para `_sincronizarEmpresa` (cooldown por CNPJ), que é o caminho de produção.

---

## 8. Riscos

| Risco | Mitigação / estado |
|---|---|
| Lotes já perdidos com NSU avançado **antes** desta correção | DistDFe não reenvia. Recuperação exige consulta autorizada por chave ou intervenção manual de NSU (**fora desta etapa**). |
| Operador interpreta `AGUARDAR_JANELA_DFE` como “SEFAZ sem notas” | Mensagem e UI agora dizem que a consulta **não executou**. |
| `data_emissao` derivada da chave usa dia 01 | Pode deslocar o documento no filtro “hoje”, mas o **mês vigente** passa a incluir. Preferível a sumir. |
| Cooldown de 1 h após 137/138 com `ult = max` | Preservado de propósito (NT 2014.002 / consumo indevido). |
| CNPJ ou ambiente errados | Não comprovado aqui; DistDFe real pode continuar vazio. |
| MULTIEMPRESA: cooldown global de `executar()` segue inativo | Correto: cada CNPJ avalia na sincronização da empresa. |

---

## 9. Itens ainda não homologados

- Consulta DistDFe **real** (produção ou homologação SEFAZ).
- Certificado e CNPJ/ambiente da empresa operacional.
- Existência da NF-e esperada na fila DistDFe daquele CNPJ no mês vigente.
- Recuperação de NSU já avançado sobre lote historicamente perdido.
- Homologação operacional de estoque / barra de progresso (pendência da etapa anterior — inalterada).
- Manifestação 210210 (sem evidência específica nesta investigação).

---

## 10. Critério de aceite

| Critério | Status |
|---|---|
| Distinguir consulta **executada** de consulta **ignorada** | **Atendido** (DTO, serviço, evento, UI, testes) |
| Não perder documentos por falha de persistência (hold de NSU + retry + `errosPersistencia`) | **Atendido** em isolado |
| Exibir documentos já recebidos no mês vigente (incluindo XML sem `dhEmi`) | **Atendido** em isolado |
| Isolamento por empresa | **Atendido** |
| Não declarar DistDFe real homologado | **Cumprido** — resultado operacional SEFAZ permanece **não GO** |

**Aceite desta etapa:** correção interna comprovada por testes isolados.  
**Não aceite:** “a Central passou a achar a NF-e do mês na SEFAZ.” Isso exige DistDFe autorizado em janela controlada, com CNPJ/ambiente conferidos.
