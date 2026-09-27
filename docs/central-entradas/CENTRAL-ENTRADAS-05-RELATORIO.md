# CENTRAL-ENTRADAS-05 — Cancelamento + Política de Manifestação + Expiração de Claim

Data: 27/09/2026 · Ambiente: desenvolvimento local, bancos temporários · **Produção NÃO homologada.**

---

## 1. Objetivo

Corrigir três riscos de segurança operacional da Central de Entradas, sem novos mecanismos:

- **P19** — cancelamentos (110111/110112) recebidos pelo DistDFe não eram aplicados (ReferenceError silencioso).
- **P08** — o Motor de Recuperação enviava Ciência 210210 com `confirmado: true`, ignorando a política de manifestação.
- **CLAIM** — o claim de manifestação (`MANIFESTACAO_CLAIM`) não tinha validade: um processo que caísse após reclamar travava o documento para sempre.

## 2. P19 — Cancelamento recebido pelo DistDFe

**Causa raiz.** Em `persistirDocumentosRetorno` (`backend/services/fiscal/distribuicaoDFe.js`), o laço de eventos usava `empresaIdPersistencia`, mas a constante só era declarada depois do laço (zona morta temporal). Todo evento com efeito fiscal lançava `ReferenceError`, capturado pelo `try/catch` e reduzido a um `console.warn('[DFE] falha ao aplicar evento: …')`. O documento permanecia no status anterior.

**Correção.** A linha `const empresaIdPersistencia = resolverEmpresaIdPersistenciaDfe(ctxAudit, persistencia);` foi movida para antes do laço de eventos. Mesma função e mesma resolução de empresa (contexto → persistência), agora usadas pelos eventos e pelos documentos. Nenhum mecanismo novo: os eventos seguem o fluxo existente `persistencia.aplicarEventoDfe` → `DocumentoTransitionService` (máquina de estados) → `documentosRepository.atualizar` → auditoria `tipo: 'EVENTO'`.

**Prova de que os testes pegam o bug.** A linha foi recolocada temporariamente na posição antiga e a suíte CE-05 foi executada. **7 dos 8 testes P19 falharam**; o P19-05, lote sem eventos, passou, como esperado. Com a correção restaurada, os 8 passam.

## 3. P08 — Política de manifestação no Motor de Recuperação

**Causa raiz.** `MotorRecuperacaoXmlService._consultarDocumento` (ramo RESUMO sem aceite e sem 596) chamava `processarDocumento(id, { confirmado: true, … })`. O `confirmado: true` fazia o serviço tratar o envio como autorizado pelo operador, qualquer que fosse a política (MANUAL / CONFIRMAR_OPERADOR).

**Correção em duas camadas:**

1. **Motor** (`MotorRecuperacaoXmlService`):
   - Antes de qualquer envio, lê a política configurada (`_obterPoliticaManifestacaoSegura`: dependência injetável `obterPoliticaManifestacao` ou a configuração do próprio serviço de manifestação). Falha de leitura não autoriza envio.
   - Se a política **não** for `AUTOMATICA_CIENCIA`:
     - nenhuma chamada ao serviço de manifestação, nenhum SOAP, nenhum claim;
     - nenhum evento falso (`CIENCIA_ENVIADA` / `MANIFESTACAO_ACEITA`);
     - estado observável `ultimoRetorno: 'AGUARDANDO_POLITICA_MANIFESTACAO'`, `politica` e `motivo` no estado do documento, mais log `RECUPERACAO_XML` / `Etapa: politica_manifestacao`;
     - tentativas não incrementadas; documento permanece na fila e disponível ao operador.
   - Com `AUTOMATICA_CIENCIA`: chama o serviço com `origemAutomatica: true` e **sem** `confirmado`.
2. **Serviço** (`CentralManifestacaoDfeService._processarDocumento`) — regra de negócio:
   - Com `origemAutomatica: true`, `opcoes.confirmado` e `opcoes.politica` do chamador são ignorados.
   - Só a política configurada autoriza a Ciência.
   - `processarCandidatos` (sincronização automática) também passa `origemAutomatica: true`.
   - A confirmação explícita do operador (rota manual, sem `origemAutomatica`) continua funcionando.

**Distinção preservada:** scheduler MANUAL (sincronização desligada) ≠ política MANUAL. A política é avaliada em cada execução; mudar MANUAL↔AUTO vale na execução seguinte.

**Ordem efetiva antes do 210210.**
- **Motor:** política → serviço.
- **Serviço:** política (sem SOAP) → contexto → aceite/596/janela → Gate por empresa → claim → envio.

A política é conferida duas vezes (motor e serviço) e sempre antes de qualquer SOAP ou claim. Nos cenários bloqueados, Gate 656, janela pós-596 e política resultam todos em zero SOAP.

## 4. Claim — expiração e recuperação

A evolução foi feita sobre `_reclamarManifestacao` / `_liberarClaim`, mantendo o único mecanismo existente: o evento `MANIFESTACAO_CLAIM` protegido pelo índice único `idx_central_eventos_manif_claim`.

- **Dono e validade.** Todo claim grava em `detalhe`:
  - `token` (UUID);
  - `processo`;
  - `reclamadoEm` e `expiraEm`, pelo relógio injetável `agora`;
  - `ttlMs`.
- **Conflito com claim válido.** Continua bloqueando ("Manifestação já em andamento…").
- **Conflito com claim expirado:**
  - A recuperação é atômica por compare-and-swap no próprio registro: `UPDATE … WHERE id = ? AND tipo = ? AND detalhe_json IS <versão lida>`, via o novo método `CentralEventosRepository.substituirDetalheSeInalterado`.
  - Só um processo obtém `changes === 1`. O índice único continua garantindo um único claim por documento, e o claim não é apagado.
- **Rastro.** Quem vence grava o evento `MANIFESTACAO_CLAIM_RECUPERADO`, com:
  - `claimOriginal` (`claimId`, `token`, `processo`, `reclamadoEm`, `expiradoEm`);
  - `recuperadoPor` (`token`, `processo`);
  - `recuperadoEm` e `ttlMs`.

  O novo claim também guarda `recuperadoDe` (id, processo e datas do anterior), e há log `MANIFESTACAO` / `Etapa: claim_recuperado`.
- **Liberação por dono.** `_liberarClaim(documentoId, token)` usa o novo `removerPorTipoDocumentoToken`. Um processo atrasado cujo claim foi recuperado não apaga o claim do novo dono. Sem token, mantém o comportamento anterior (`removerPorTipoDocumento`), o que preserva a compatibilidade com repositórios simulados.
- **Aceite concorrente.** Com o claim em mãos, o serviço confere novamente se já existe `MANIFESTACAO_ACEITA` (`_confirmarClaimSemAceite`). O aceite é gravado antes da liberação do claim, então isso fecha a janela em que um processo leu "sem aceite" antes de outro concluir.
- **Claims anteriores à CE-05** (sem `reclamadoEm`): a idade é calculada por `created_at` (UTC do SQLite).
- **Não implementado, conforme escopo:** limite de 48 tentativas, limite de 30 dias, XML_INDISPONIVEL automático por tentativas, encerramento automático por 596.

## 5. TTL utilizado

`TTL_CLAIM_MANIFESTACAO_MS = 10 * 60 * 1000` (10 minutos), constante única em `CentralManifestacaoDfeService.js`, exportada no módulo.

Não havia configuração de TTL de claim a reutilizar. `INTERVALO_SEGURO_MS` (1 h) tem outra finalidade: a janela de consulta.

O valor supera com folga o timeout SOAP da SEFAZ (`FISCAL_SOAP_TIMEOUT_MS`, padrão 90 s, em `soapClient.js`), para nunca expirar um envio em andamento. A suíte verifica `TTL > 90000`.

## 6. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `backend/services/fiscal/distribuicaoDFe.js` | P19: declaração de `empresaIdPersistencia` antes do laço de eventos (uma linha movida). |
| `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js` | P08: `origemAutomatica` na regra de política, `processarCandidatos` com `origemAutomatica`. CLAIM: `TTL_CLAIM_MANIFESTACAO_MS`, `_montarDetalheClaim`, `_inicioClaim`, `_recuperarClaimExpirado`, `_confirmarClaimSemAceite`, `_liberarClaim(documentoId, token)`, token repassado nas liberações. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | P08: verificação da política antes da ciência, estado `AGUARDANDO_POLITICA_MANIFESTACAO`, dependências opcionais `manifestacaoService` / `obterPoliticaManifestacao`, chamada com `origemAutomatica` (sem `confirmado`). |
| `backend/motores/central-entradas/repositories/CentralEventosRepository.js` | Métodos `obterUnicoComVersao`, `substituirDetalheSeInalterado` (CAS), `removerPorTipoDocumentoToken`. |
| `backend/motores/central-entradas/config/centralEventosTipos.js` | Novo tipo `MANIFESTACAO_CLAIM_RECUPERADO`. |
| `tests/central-entradas/central-entradas-05-seguranca.test.js` | Nova suíte (28 testes). |
| `package.json` | Script `test:central-entradas-05`. |

## 7. Arquivos não alterados (lista de proteção)

Não foram tocados:
- **Configuração fiscal e certificados:** `empresas_configuracao_fiscal.ambiente`, `configuracoes.fiscal_ambiente`, certificados PFX, CNPJs, cursores NSU, `RegistryBuilder`, URLs oficiais.
- **Contexto por empresa:** `CentralEntradasEmpresaContextoService`, `resolverContextoDocumentoCentral`.
- **Contenção SEFAZ da CE-04:** `CentralSefazOperationalGate` (Gate 656 por empresa e cooldown 656), `proximaConsultaEm` pós-596 (`_proximaConsultaDocumento` / `_registrarConsultaPos596`).
- **Locks e recuperação:** `LOCKS_DOCUMENTO_SEFAZ` / `adquirirLockDocumentoSefaz`, lock do Motor de Recuperação, regra de não remanifestação da recuperação XML (`modoRecuperacaoXml`).
- **Demais motores e módulos:** MUC, MIIP, Motor Fiscal, Estoque, Financeiro, PDV, TEF, MBC, Motor de Composição, NFC-e.

`CentralDfePersistenciaService.aplicarEventoDfe` (fluxo de cancelamento) foi reutilizado sem alteração. Nenhum scheduler, Gate, fila ou mecanismo de claim novo foi criado.

## 8. Testes novos

`tests/central-entradas/central-entradas-05-seguranca.test.js`, com 28 testes.

**Características:**
- Determinística, com relógio controlado.
- `DB_DIR` temporário e `database` substituído por SQLite `:memory:`.
- Gate isolado por cenário (instância com repositório em memória).
- SOAP e 210210 simulados, sem certificado real; endpoint `mock.sefaz.invalid`.

**Código real exercitado:**
- `sincronizarDistribuicaoDFe` → `persistirDocumentosRetorno`;
- `aplicarEventoDfe`;
- `DocumentoTransitionService` com a máquina de estados real;
- `CentralManifestacaoDfeService`;
- `MotorRecuperacaoXmlService`.

**Claims:** `CentralEventosRepository` sobre **SQLite real em arquivo temporário**, com o schema oficial de `central_entradas_eventos` e os índices únicos, e **duas conexões** simulando dois processos. A concorrência é real: `Promise.all` sobre conexões distintas, com `busyTimeout`.

- **P19-01..08:**
  - 01 e 02: 110111 e 110112 → CANCELADA, com NSU e `statusDetalhe` gravados, transição no histórico, auditoria `EVENTO/CANCELADA` e nenhum `falha ao aplicar evento`.
  - 03: mesma chave em duas empresas → só a empresa do evento muda.
  - 04: mesmo número e série em empresas diferentes → isolamento, inclusive com o evento chegando pela empresa errada.
  - 05: lote sem eventos → procNFe persistido.
  - 06: lote misto (procNFe + 210210 + 110111) processado por completo.
  - 07: evento desconhecido (999999) não altera o status e o documento seguinte do lote é processado.
  - 08: reprocessamento → uma única transição, sem nova auditoria e sem documento duplicado.
- **P08-01..10:**
  - 01: AUTOMATICA → 1 ciência.
  - 02: MANUAL → zero 210210 e zero SOAP, sem `CIENCIA_ENVIADA`, aceite ou claim; estado `AGUARDANDO_POLITICA_MANIFESTACAO`.
  - 03: CONFIRMAR_OPERADOR → zero envio; em seguida, o operador confirma e envia.
  - 04 e 05: MANUAL e CONFIRMAR_OPERADOR com o agendamento automático (`processarCandidatos` + dois ciclos do motor) → zero envio.
  - 06: AUTOMATICA com Gate 656 da empresa bloqueado → zero SOAP.
  - 07: AUTOMATICA com janela pós-596 vigente → zero SOAP e sem remanifestação.
  - 08: MANUAL→AUTO → o ciclo seguinte envia.
  - 09: AUTO→MANUAL → o ciclo seguinte não envia para um novo documento.
  - 10: motor com leitura de política divergente (AUTO) e configuração real MANUAL → zero envio. Chamada direta com `origemAutomatica + confirmado:true + politica:AUTO` → ignorada, política MANUAL.
- **CLAIM-01..10:**
  - 01: aquisição com token, processo e expiração.
  - 02: claim válido bloqueia o segundo processo.
  - 03: claim expirado é recuperado.
  - 04: 20 rodadas de recuperação simultânea em duas conexões → exatamente um vencedor por rodada e uma recuperação registrada.
  - 05: TTL − 1 ms → sem recuperação.
  - 06: liberação normal funciona, inclusive a liberação após rejeição 596 no fluxo completo.
  - 07: após um crash, o claim permanece; bloqueado a TTL − 1 s e recuperável a TTL + 1 s.
  - 08: histórico completo; a liberação tardia do dono antigo não remove o claim novo.
  - 09: claims de empresas diferentes não interferem.
  - 10: dois `processarDocumento` concorrentes após a expiração → exatamente 1 ciência e 1 aceite; a execução seguinte não reenvia.

## 9. Resultado individual

| Suíte | Resultado |
|---|---|
| `npm run test:central-entradas-05` | **28 ok, 0 falha(s)** (exit 0) |

Durante o desenvolvimento, a primeira execução revelou um defeito real, corrigido antes da versão final (CLAIM-08). O claim novo guardava o token do dono anterior em `recuperadoDe`. Com isso, a liberação por dono do processo antigo, que busca o token no `detalhe_json`, removia o claim do novo dono. O token anterior agora fica só no evento de histórico.

## 10. Regressão CE-03

| Suíte | Resultado |
|---|---|
| `central-entradas-03-xml` | 17 ok, 0 falha(s) |
| `central-entradas-03-periodo` | 12 ok, 0 falha(s) |
| `npm run test:central-entradas-03` | exit 0 |

## 11. Regressão CE-04

| Suíte | Resultado |
|---|---|
| `npm run test:central-entradas-04` | 21 ok, 0 falha(s) (exit 0) |

## 12. Regressão geral (Central)

Todas as suítes `tests/central-entradas/*.test.js` foram executadas, cada uma com `DB_DIR` temporário novo. Logs e `resumo.csv` estão em `%TEMP%\ce05-reg-final\`.

| | CE-04 (base) | CE-05 |
|---|---|---|
| Suítes | 79 | 80 (+ CE-05) |
| PASS | 50 | **51** |
| FAIL | 29 | 29 (mesmo conjunto) |
| Logs mencionando o banco oficial | 0 | 0 |

**Comparação teste a teste com os logs da CE-04** (linhas de falha normalizadas):
- **Diferenças sem efeito no resultado:** quase todas são apenas a ordem de mensagens de inicialização do banco temporário (`duplicate column name: tef_*`).
- **Única diferença substantiva:** `rc333-hardening`, teste "mutex único: sync concorrente". Ver a seção 13.

## 13. Falhas pré-existentes

Há 29 suítes que já falhavam na linha de base da CE-04, com as mesmas contagens:

> auditoria-leitores-globais-05-73, sprint2, sprint4, sprint5, sprint7, sprint9, sprint10, rc1, rc3, rc31, rc33, rc333, rc343, rc346, rc348, rc349a, rc3753, rc376, rc4, rc40, rc6.2, rc6.4, rc6.5, rc74, rc741, rc742, rc743, rc75, rc833.

Nenhuma falha nova foi introduzida.

**Observação sobre `rc333-hardening`.** O mesmo teste falha nas duas rodadas, com o mesmo placar (5 passou, 1 falhou), mas em asserções diferentes:
- na CE-04, `efetivas` 2 ≠ 1;
- na CE-05, `ignorados.length >= 2`, com `efetivas` já igual a 1.

A inspeção mostrou uma corrida pré-existente no próprio teste. `CentralSyncExecucaoService.executar()` aguarda o Gate singleton (`autorizarConsultaDistDfe`, com leitura real do SQLite) antes de adquirir o mutex, enquanto `comLockDistDfe('scheduler')` adquire o mutex imediatamente. O desfecho depende da temporização de I/O. Nenhum arquivo desse caminho foi alterado na CE-05: `CentralSyncExecucaoService` e o Gate estão intactos, e `centralEventosTipos` apenas ganhou uma chave. A falha fica classificada como **pré-existente, sensível a tempo**.

**Ruído conhecido.** Nas suítes CE-05 e CE-04 aparecem mensagens `SQLITE_ERROR: no such table: central_entradas_eventos`. Elas vêm do emissor de eventos padrão escrevendo no banco stub `:memory:` do harness, que não tem tabelas. Não afetam resultados e não envolvem banco real.

## 14. Banco oficial não utilizado

- Todas as execuções usaram `DB_DIR` temporário em `%TEMP%` (`ce05-*`). As suítes CE-04 e CE-05 substituem `backend/database` por SQLite `:memory:`.
- Os bancos de claim da CE-05 são arquivos em `DB_DIR` temporário. A suíte afirma que nem `DB_DIR` nem esses arquivos correspondem a `MercantilFiscal\dados\mercadao.db`.
- A varredura dos 80 logs da regressão não encontrou nenhuma menção a `C:\ProgramData\MercantilFiscal\dados\mercadao.db`.
- Nenhum comando `node` foi executado sem `DB_DIR` temporário nesta sprint.

## 15. Nenhuma chamada SEFAZ real

- Todo transporte DistDFe e consChNFe foi simulado (`enviarDistribuicaoDfe` injetado, endpoint `https://mock.sefaz.invalid/…`).
- O 210210 foi simulado (`enviarManifestacao` injetado, `prepararEnvelopeAssinado` retornando um envelope fixo).
- Nenhum certificado real foi carregado: o caminho do PFX é fictício e nunca foi aberto.
- Nenhuma manifestação real foi enviada. A configuração fiscal real não foi alterada.

## 16. Pendências

- **CE-06 (próxima etapa, não misturada aqui):** P01, P04, P09, P14, P15.
- **TTL de 10 minutos.** Um claim órfão bloqueia o documento por até 10 minutos antes de poder ser recuperado. Esse atraso é intencional, para não expirar um envio ainda em andamento.
- **Claims legados.** O cálculo da idade de claims anteriores à CE-05, sem `reclamadoEm`, usa `created_at` (UTC). Isso não foi exercitado com dados reais de Produção.
- **Locks por processo.** `LOCKS_DOCUMENTO_SEFAZ` continua sendo por processo, sem alteração. A proteção entre processos é o claim com índice único.
- **Política informada por parâmetro.** `processarCandidatos` ainda aceita `opcoes.politica` do chamador para decidir se executa. Hoje nenhum chamador passa esse parâmetro, e o envio em si é conferido de novo por `origemAutomatica` contra a configuração.
- **Teste instável fora do escopo.** O teste "mutex único" da `rc333-hardening` é sensível a tempo e pré-existente.
- **Produção.** Nenhuma validação em Produção foi feita. **Produção NÃO está homologada.**

## 17. Conclusão

As três correções de segurança da CE-05 foram implementadas com mudanças mínimas e sem mecanismos novos:

- **P19:** cancelamentos 110111/110112 recebidos pelo DistDFe voltam a atualizar o documento para CANCELADA, pelo fluxo existente e com isolamento por empresa.
- **P08:** o Motor de Recuperação e a sincronização automática só enviam Ciência 210210 com a política `AUTOMATICA_CIENCIA`. Um `confirmado: true` vindo de fluxo automático não contorna mais a política.
- **CLAIM:** o claim de manifestação tem validade centralizada (10 min), recuperação atômica por compare-and-swap com rastro completo e liberação restrita ao dono, mantendo o índice único e a proteção de concorrência.

Resultados:
- A suíte nova passou 28 de 28, incluindo concorrência real sobre SQLite.
- CE-03 (17 + 12), CE-04 (21) e a regressão geral (51 PASS; 29 falhas pré-existentes, sem falhas novas) confirmam que nada regrediu.
- Não houve chamada SEFAZ real e o banco oficial não foi usado.

Isto **não** declara Produção homologada.
