# CENTRAL-ENTRADAS-04 — Contenção SEFAZ + Gate por empresa + fim do loop 596

Data: 27/09/2026
Escopo: correção de P02 e P03 (CENTRAL-AUDIT-01) e preparação de P01.

| Item | Resultado |
|---|---|
| Suíte nova `central-entradas-04-gate.test.js` | **21/21** (16 obrigatórios + 5 complementares) |
| CENTRAL-ENTRADAS-03 (XML + período) | **17/17** e **12/12** |
| Regressão da Central (79 suítes, `DB_DIR` temporário por suíte) | **50 PASS**, **0 FAIL NOVO**, **29 FAIL PRÉ-EXISTENTE** (as mesmas 29 da CE-03 / BANCO-INIT-01) |
| Banco oficial aberto por teste | **Nenhum** (0 de 79 logs mencionam o caminho oficial) |
| Chamada SEFAZ real | **Nenhuma** |
| Produção | **Não validada.** Nenhum teste real em Produção foi executado. |

---

## 1. Objetivo

Parar as consultas repetidas à SEFAZ depois de uma ciência rejeitada por prazo (596), fazer o 656 alimentar o Gate existente e tornar esse Gate **por empresa** (empresaId + CNPJ + ambiente), para que o bloqueio de uma empresa nunca pare outra. O Gate passa a ser consultado antes de distNSU, consChNFe, ciência 210210 e recuperação XML.

Nada foi executado contra a SEFAZ: nenhuma sincronização, manifestação, consChNFe ou recuperação real, e as 18 notas novas não foram processadas.

## 2. P02 (loop pós-596): antes e depois

**Antes.** Cada chamada de `processarDocumento` num documento com 596 registrado caía em `_resolverAposEvento596` e disparava consChNFe **sem olhar janela nenhuma**. Scheduler, botão e motor chamavam em sequência, e os documentos 47–50 receberam 9 consChNFe cada até o 656 das 17:33 e das 17:47 UTC. Havia também um defeito no lock por documento: `return this._consultar...()` sem `await` dentro do `try/finally` liberava o lock **antes** da consulta SOAP terminar, então o lock não protegia nada durante a consulta.

**Depois.**
- `_resolverAposEvento596` lê o `proximaConsultaEm` do último evento `CONSULTA_DFE_POS_MANIFESTACAO`. Dentro da janela, retorna `AGUARDANDO_JANELA_POS_596` sem SOAP e sem gravar evento. Só uma confirmação explícita de admin (`forcarAdminConfirmado` + `confirmacaoAdmin`) ignora a janela.
- O Gate da empresa é consultado antes do consChNFe.
- O Motor de Recuperação respeita a mesma janela para qualquer documento. Depois do próprio consChNFe pós-596, o motor grava `CONSULTA_DFE_POS_MANIFESTACAO` com `cStat`, `xMotivo` e `proximaConsultaEm` (+1 h).
- Os cinco `return` dentro do bloco com lock passaram a `return await`, e o lock agora cobre a consulta inteira.
- O 596 **não** vira XML_INDISPONIVEL sozinho. A regra anterior se mantém: só encerra com evidência (consChNFe 137).

## 3. P03 (656 fora do Gate): antes e depois

**Antes.** Um consChNFe com 656 voltava como retorno normal (`cStat 656`) dentro do serviço de manifestação. O orquestrador reportava ao Gate apenas o `cStat` agregado do resultado, que no caminho pós-596 era o `596` da ciência, então o 656 do consChNFe se perdia. O 656 da ciência 210210 nunca chegava ao Gate. Quando chegava (sync agregada), o bloqueio era **global**.

**Depois.**
- `distribuicaoDFe` (consChNFe e distNSU) reporta **cada** resposta SOAP ao Gate com o contexto da empresa, via `deps.gateSefaz`.
- O serviço de manifestação reporta o retorno do 210210.
- Cada resposta é reportada **uma única vez**: os chamadores que passam `gateSefaz` deixaram de reportar por conta própria (motor, `buscarPorChave`), e o orquestrador e o `CentralSyncExecucaoService` pulam o reporte global quando o resultado vem com `gateProcessado: true`.

## 4. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `backend/motores/central-entradas/services/CentralSefazOperationalGate.js` | Bloqueio 656 e cooldown progressivo **por contexto** (`empresaId\|cnpj\|ambiente`) dentro do Gate existente: `normalizarContextoGate`, `registrarBloqueio656Contexto`, `obterBloqueio656Contexto`, `estaBloqueado656Contexto`, `listarBloqueios656PorEmpresa`. Persistência em `bloqueios656PorEmpresa` / `contador656PorEmpresa` e telemetria. `autorizarConsultaDistDfe` e `processarRespostaSefaz` usam o contexto quando ele vem completo; sem contexto, o comportamento global é o de antes. |
| `backend/services/fiscal/distribuicaoDFe.js` | Com `deps.gateSefaz`, verifica o Gate antes do SOAP (distNSU, inclusive a cada iteração, e consChNFe) e reporta cada resposta com o contexto da empresa. Bloqueio: distNSU retorna `bloqueadoGate` sem tocar no NSU; consChNFe lança erro com `bloqueadoGate`. Sem `gateSefaz`, nada muda. |
| `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js` | Gate por empresa antes do 210210, do distNSU e do consChNFe; reporte do retorno do 210210; janela pós-596; lock por documento promovido a nível de módulo (`adquirirLockDocumentoSefaz` / `liberarLockDocumentoSefaz`); correção `return await` no bloco com lock; `gateProcessado` no resultado. |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | Pula o reporte global quando `gateProcessado === true`. |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | Idem (o 656 de uma empresa não vira bloqueio global). |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Gate por empresa em `_sincronizarEmpresa`: a empresa bloqueada é pulada com `bloqueadoGate` e `proximaConsultaEm`, e as demais seguem. `gateSefaz` repassado ao distNSU; `buscarPorChave` passa a usar o Gate por empresa e remove o reporte global duplicado. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | Contexto resolvido **antes** do Gate e enviado a ele; janela `proximaConsultaEm` do documento; lock por documento compartilhado com o serviço de manifestação; `gateSefaz` no consChNFe (reporte único); evento pós-596 com janela; o serviço de ciência interno recebe o mesmo Gate. |
| `backend/motores/central-entradas/services/CentralDiagnosticoService.js` | "Testar SEFAZ" envia empresaId/CNPJ/ambiente do contexto ao Gate (autorização e reporte). |
| `backend/motores/central-entradas/contracts/CandidatoManifestacaoDTO.js` (novo) | Contrato P01 (função pura, ainda não ligada à seleção). |
| `tests/central-entradas/central-entradas-04-gate.test.js` (novo) | Suíte da sprint. |
| `tests/central-entradas/central-entradas-03-xml.test.js` | Harness: Gate real **isolado por cenário** (ver seção 14). |
| `package.json` | Script `test:central-entradas-04`. |

## 5. Arquivos não alterados

- `empresas_configuracao_fiscal.ambiente`, `configuracoes.fiscal_ambiente` (continua `2`), certificados PFX, CNPJ das empresas e cursores NSU: nenhum dado foi alterado.
- RegistryBuilder, URLs oficiais de Produção e contexto operacional multiempresa (`CentralEntradasEmpresaContextoService`, `resolverContextoDocumentoCentral`, `CentralConfiguracaoService`).
- Claim de manifestação (`_reclamarManifestacao` / `_liberarClaim`). O Gate foi colocado **antes** do claim, sem alterar o claim em si.
- Lock do Motor de Recuperação da CE-03 (`_cicloEmExecucao`), que continua igual. O lock por documento é o `_emExecucao` que já existia no serviço de manifestação, agora compartilhado, e não um lock paralelo.
- Regra de que a recuperação XML não remanifesta.
- `CentralXmlWaitScheduler`, `MirxWorker`, `MirxService`, `processarCandidatos` (P01).
- Motor Fiscal, MIIP, MUC, Estoque, Financeiro, PDV, TEF, MBC, Motor de Composição, Produção e NFC-e.
- Nenhum Gate, scheduler, fila ou mecanismo de cooldown novo foi criado.

## 6. Fluxo do Gate

```
Qualquer camada (sync, botão/buscar-chave, MIRX/orquestrador, manifestação, motor, diagnóstico)
  │  contexto = { empresaId, cnpj, ambiente }  (do documento ou da empresa)
  ▼
Gate.autorizarConsultaDistDfe(contexto)
  ├─ 593 ativo (global)                    → nega (ERRO_CONFIGURACAO_CERTIFICADO)
  ├─ bloqueio 656 da chave empresa|cnpj|amb → nega (BLOQUEADO_CONSUMO_INDEVIDO_656, escopo EMPRESA, proximaConsultaEm)
  └─ senão                                  → permite
  ▼
SOAP (distNSU / consChNFe / 210210)
  ▼
Gate.processarRespostaSefaz({cStat, xMotivo}, contexto)   ← exatamente uma vez por resposta
  ├─ 656 → bloqueio da empresa (cooldown 10→20→40→60→120 min), SEFAZ_GATE_BLOCK
  ├─ 137/108/109 → backoff; demais → continuar; zera o contador 656 da empresa
  └─ sem contexto → comportamento global legado
```

Quando o Gate nega, a camada retorna `bloqueadoGate: true` com `proximaConsultaEm` **sem gravar evento de consulta** e sem tocar NSU ou claim. O MIRX já tratava `BLOQUEADO_CONSUMO_INDEVIDO_656` colocando o documento em sleep até `proximaConsultaEm`.

## 7. Isolamento por empresa

- A chave do bloqueio é `empresaId|CNPJ|ambiente`. Com empresaId disponível não há fallback global: sem contexto completo, o Gate usa o circuito global legado (EMPRESA_SIMPLES / chamadores antigos).
- Sincronização multiempresa: a empresa bloqueada é pulada (`porEmpresa[].bloqueadoGate`) e as demais sincronizam no mesmo ciclo (T10).
- consChNFe, 210210 e distNSU da empresa 1 seguem com a empresa 2 bloqueada (T08, T10, T11).
- Um 656 na empresa 2 deixa as empresas 1 e 3 liberadas e o circuito global intacto (T04, T06).

## 8. Tratamento 596

| Situação | Comportamento |
|---|---|
| Ciência retorna 596 | Registra `MANIFESTACAO_REJEITADA` (cStat, xMotivo, horário) e faz **um** consChNFe (se o Gate permitir). O resultado vai para `CONSULTA_DFE_POS_MANIFESTACAO` com `proximaConsultaEm` = agora + 1 h. |
| Nova chamada antes da janela (scheduler, botão, MIRX, motor) | `AGUARDANDO_JANELA_POS_596`, 0 SOAP, nenhum evento. |
| Gate da empresa bloqueado | `bloqueadoGate`, 0 SOAP, nenhum evento. |
| consChNFe 632 / 640 / 656 / timeout | Não encerra, e o documento continua RESUMO_RECEBIDO. |
| consChNFe 137 | Encerra em XML_INDISPONIVEL com o cStat real (regra anterior, inalterada). |
| Remanifestação | Nunca. |

## 9. Tratamento 656

- **Origens cobertas:** consChNFe, distNSU e retorno do 210210.
- **Registro:** `{ empresaId, cnpj, ambiente, motivo: CONSUMO_INDEVIDO, cStat: 656, xMotivo, iniciadoEm, bloqueadoAte, intervaloMs, ocorrencia, documentoId, chave, nsu, endpoint, origem, correlationId }`, persistido no estado do Gate (`bloqueios656PorEmpresa`). Sobrevive a reinício (T16).
- **Cooldown progressivo por empresa:** usa o mesmo `COOLDOWN_656_MINUTOS` já existente (T18).
- **Liberação automática:** ao fim do cooldown o estado volta a `OPERACIONAL` (T14).
- **Observabilidade:** `obterBloqueio656Contexto` e `listarBloqueios656PorEmpresa`, também na telemetria, expõem Empresa, CNPJ, Ambiente (`PRODUCAO`/`HOMOLOGACAO`), Motivo, cStat, xMotivo, data/hora, início e fim do cooldown e estado atual (`BLOQUEADO`/`OPERACIONAL`). O log `SEFAZ_GATE_BLOCK` sai com os mesmos campos.

## 10. proximaConsultaEm

- É persistido no `detalhe` do evento `CONSULTA_DFE_POS_MANIFESTACAO`, gravado **somente quando houve consulta SOAP**. Chamadas bloqueadas (janela ou Gate) não gravam evento e não empurram a janela.
- É lido por `_resolverAposEvento596` e pelo Motor de Recuperação antes de qualquer consChNFe.
- O Gate expõe seu próprio `proximaConsultaEm` (fim do cooldown 656) nas negativas.
- Chamar o método não autoriza consulta: uma chamada fora da janela ou com o Gate bloqueado retorna sem SOAP.

## 11. Locks

- **Por documento:** `LOCKS_DOCUMENTO_SEFAZ` (o `_emExecucao` que já existia, agora em escopo de módulo). É compartilhado entre todas as instâncias do serviço de manifestação (sync, botão, MIRX, ciência chamada pelo motor) e o consChNFe direto do motor. Scheduler + motor + botão simultâneos resultam em **1** consulta (T12).
- **Correção:** `return await` nos cinco retornos dentro do `try/finally`. Sem ela, T12 falhava com 2 consultas, o que confirmou o defeito.
- **Janela:** botão seguido do motor dentro da janela também resulta em **1** consulta (T12b).
- **Mantidos sem alteração:** o lock de ciclo do motor (CE-03) e o mutex da sync (`comLockDistDfe`).

## 12. Testes executados

Todos com `DB_DIR` temporário, `backend/database` substituído por SQLite `:memory:` nas suítes novas, transporte SOAP simulado e Gate real instanciado com repositório em memória e relógio controlado.

- `node tests/central-entradas/central-entradas-04-gate.test.js` (`npm run test:central-entradas-04`)
- `node tests/central-entradas/central-entradas-03-xml.test.js` e `central-entradas-03-periodo.test.js`
- As 79 suítes de `tests/central-entradas/*.test.js`, cada uma com um `DB_DIR` novo em `%TEMP%`.

Mocks determinísticos de retorno (`retDistDFeInt` / `retEvento`): 596, 656, 135, 137, 138 (com procNFe em docZip gzip), 632, 640 e timeout de transporte.

## 13. Resultado de cada teste

| # | Teste | Resultado |
|---|---|---|
| T01 | 596 → `processarDocumento` ×2 → exatamente 1 consulta SEFAZ | PASS |
| T02 | 596 com `proximaConsultaEm` futura → 0 consultas (serviço e motor) | PASS |
| T03 | 596 com Gate da empresa bloqueado → 0 consultas | PASS |
| T04 | consChNFe 656 bloqueia o Gate da empresa (global intacto) | PASS |
| T05 | Manifestação 210210 com 656 bloqueia o Gate da empresa | PASS |
| T06 | Empresa 2 recebe 656 → empresas 1 e 3 liberadas | PASS |
| T07 | Empresa 2 bloqueada → consChNFe da empresa 2 não executa (distribuição, serviço, motor) | PASS |
| T08 | Empresa 2 bloqueada → consChNFe da empresa 1 executa (procNFe persistido) | PASS |
| T09 | Empresa 2 bloqueada → distNSU da empresa 2 não consulta nem lê/altera o NSU | PASS |
| T10 | Empresa 2 bloqueada → distNSU das empresas 1 e 3 continua (inclusive via `CentralSincronizacaoService`) | PASS |
| T11 | Empresa 2 bloqueada → 210210 da empresa 2 não é enviado (sem claim); empresa 1 manifesta | PASS |
| T12 | Scheduler/botão + motor simultâneos → 1 consulta por documento | PASS |
| T12b | Botão e depois motor dentro da janela → 1 consulta | PASS |
| T13 | 656 + cooldown → consChNFe, distNSU e 210210 bloqueados | PASS |
| T14 | Cooldown expirado → consulta volta a ser permitida | PASS |
| T15 | 596 sozinho não cria XML_INDISPONIVEL (632, 640, 656, timeout, Gate) | PASS |
| T16 | cStat/xMotivo persistidos no evento, no estado do Gate e após reinício | PASS |
| T17 | Reação do Gate por cStat (137 backoff; 138/596/632/640 continuar; timeout não bloqueia; 656 bloquear) | PASS |
| T18 | Cooldown progressivo por empresa (10 → 20 min) e telemetria | PASS |
| T19 | Motor pós-596: consChNFe grava a janela e não repete no ciclo seguinte, sem remanifestar | PASS |
| T20 | Contrato P01: prazo, estado, Gate, claim e prioridade | PASS |

## 14. Regressões

Execução final: 79 suítes, cada uma com `DB_DIR` temporário próprio.

**PASS (50):** as 49 que já passavam mais a `central-entradas-04-gate`. Entre elas estão as áreas pedidas: CE-03 (xml, período), MULTICNPJ (01, 02), manifestação/ciclo DF-e (rc746, rc747-596), distribuição e NSU (rc3751, rc3752), MIRX (rc341, rc342, rc345), recuperação XML (rc336, rc375), buscar-chave por empresa (05-72) e contexto multiempresa.

**FAIL NOVO: 0** no estado final. Um ponto encontrado durante a sprint, registrado aqui:
- A CE-03 falhou em 2 cenários da Filial 3 ("erro temporário de transporte" e "retry XML_INDISPONIVEL"). A causa: a suíte usava o Gate **singleton do processo**, e o cenário anterior "656 no consChNFe" da Filial 3 agora bloqueia corretamente a Filial 3 por 10 minutos, o que contaminava os cenários seguintes. O harness passou a criar um **Gate real isolado por cenário** (mesma classe, estado em memória). Nenhuma assertiva foi alterada ou removida, e a CE-03 voltou a 17/17.

**FAIL PRÉ-EXISTENTE: 29.** É a mesma lista, nome por nome, registrada na CE-03 e na BANCO-INIT-01:

auditoria-leitores-globais-05-73, sprint2, sprint4, sprint5, sprint7, sprint9, sprint10, rc1, rc3, rc31, rc33, rc333, rc343, rc346, rc348, rc349a, rc3753, rc376, rc4, rc40, rc6.2, rc6.4, rc6.5, rc74, rc741, rc742, rc743, rc75, rc833.

**Limitação do método (declarada).** A baseline da CE-03 guardou os nomes das suítes, mas não os logs com a contagem por suíte, e as versões dos arquivos anteriores a esta sprint não estão versionadas (alterações não commitadas de sprints anteriores). Por isso, em vez de reexecutar uma cópia revertida, analisei a assertiva que falha em cada suíte que toca código alterado:
- **rc33** (cooldown por CNPJ, `codigo` undefined) e **rc333** (mutex, 2 execuções efetivas): usam um `sincronizacaoService` simulado que não devolve `gateProcessado`. A única mudança no `CentralSyncExecucaoService` é a guarda `!gateJaProcessado`, que nesse caso é idêntica ao código anterior. O que falha é o pré-cheque de cooldown e o mutex, que não foram alterados.
- **rc74, rc741, rc742, rc743:** falham em `CentralXmlWaitScheduler._processarDocumento`, que hoje delega ao `MirxWorker` e não chama o orquestrador simulado pelo teste (`consultas` 0 ≠ 1; `estaBloqueado656` false). Nenhum desses arquivos foi alterado, e as chamadas sem contexto seguem o caminho global legado do Gate.
- **rc3753** (`'offline'` ≠ `'cooldown_656'`), **rc346**, **rc348**, **rc6.x**, **sprint\***, **rc4**, **rc31**, **rc1**, **rc40**, **rc349a**, **rc75**, **rc343**, **rc376**, **rc833**, **rc3**, **auditoria-05-73**: as falhas estão em UI/texto, máquina de estados, parser/MIIP, upload, migração legado ou exigência de empresa explícita, todas fora do código desta sprint.

Contagem por suíte na execução final (para comparação futura): sprint10 3, sprint2 3, sprint4 2, sprint5 4, sprint7 1, sprint9 1, rc1 4, rc3 1, rc31 1, rc33 1, rc333 1, rc348 1, rc376 1, rc4 1, rc6.2 3, rc6.4 7, rc6.5 4, rc833 1. Abortam na primeira assertiva: auditoria-05-73, rc343, rc346, rc349a, rc3753, rc40, rc74, rc741, rc742, rc743, rc75. Logs: `%TEMP%\ce04-reg-final\`.

A suíte geral do sistema (fora da Central) não foi executada.

## 15. Confirmação de que o banco oficial não foi usado pelos testes

- Todas as 79 suítes rodaram com `DB_DIR` apontando para uma pasta nova em `%TEMP%`. Nenhum dos 79 logs contém `MercantilFiscal\dados\mercadao.db`.
- A suíte nova substitui `backend/database` por SQLite `:memory:` e o `CentralXmlWaitScheduler` por um stub antes de carregar qualquer serviço.
- Nenhum dado foi modificado manualmente para fabricar cenário: todos os cenários existem só em memória.

**Ocorrência a registrar (fora dos testes).** Durante a implementação, uma verificação de sintaxe (`node -e "require(...)"` dos serviços alterados) rodou **sem** `DB_DIR` e carregou `backend/database.js` contra o caminho oficial. Rodou a rotina de inicialização padrão do próprio sistema (a mesma de toda subida do servidor): `CREATE TABLE/INDEX IF NOT EXISTS` e migrações idempotentes. Os logs dessa rotina mostram 0 registros criados ou alterados (por exemplo `added=false`, `Migração galeria: 0 criado(s)`, `CLASSIFICADAS_VIA_CAIXA: 0`). Nenhuma escrita foi feita por mim em documentos, eventos, NSU, configuração fiscal, empresas ou certificados, e nenhuma chamada SEFAZ ocorreu. A partir daí, todos os comandos rodaram com `DB_DIR` temporário.

## 16. Confirmação de que nenhuma chamada SEFAZ real foi executada

- Em todos os testes, o transporte SOAP é `deps.enviarDistribuicaoDfe` simulado, e o envio 210210 é `enviarManifestacao` simulado.
- O endpoint devolvido pelos mocks é `https://mock.sefaz.invalid/...`.
- Os certificados são caminhos fictícios que nunca são abertos.
- Nenhuma sync, manifestação, consChNFe, distNSU ou recuperação XML real foi disparada, e nenhum cursor NSU real foi alterado.

## 17. Pendências para P01

- `processarCandidatos` continua com o **top 10 global** (`listarPorStatus(AGUARDANDO_XML_COMPLETO, 10)`, sem excluir 596). Ele não foi alterado nesta sprint. O Motor de Recuperação, que foi alterado, já ordena o lote por empresa.
- O contrato `CandidatoManifestacaoDTO.montarCandidatoManifestacao` está pronto, com empresaId, CNPJ, data de emissão, data limite (emissão + 10 dias, prazo observado nos 596), estado da manifestação (SEM_CIENCIA, CIENCIA_ENVIADA, CIENCIA_ACEITA, PRAZO_EXPIRADO_596), último cStat, `proximaConsultaEm`, Gate, claim e prioridade (`null` = não elegível agora).
- Próximo passo: selecionar por empresa (cota por empresa), excluir 596, Gate bloqueado, claim ativo e janela futura, e ordenar por dias restantes até o prazo. É isso que tira as 18 notas novas (docs 110–127) da fila atrás dos docs 45–54.

## 18. Pendências para P04/P09/P14/P15

- **P04 / P09** (painel exibe "Homologação" e certificado globais): não tratados. `_obterSnapshotFiscal` e `_obterVisaoCertificado` continuam lendo o global (`fiscal_ambiente = 2`), embora as três empresas estejam em `ambiente = 1`. A chave global **não** foi alterada.
- **P14** (Gate global): o 656 agora é por empresa. Continuam globais o estado **593** (CNPJ-base ≠ certificado) e o `fingerprintFiscalDetalhado`, então um 593 de uma empresa ainda suspende todas. Também continuam os pré-cheques globais do orquestrador, do MIRX e do `CentralSyncExecucaoService`, que agora só disparam por bloqueios globais legados (chamadas sem contexto).
- **P15** (diagnóstico): o "Testar SEFAZ" já envia o contexto ao Gate, mas o contexto vem de `obterContextoOperacional()` sem `empresaId` explícito. Falta a seleção de empresa no diagnóstico, sem fallback global em MULTIEMPRESA.
- **P02, critério da auditoria "encerra após N tentativas":** não implementado, porque esta sprint proíbe transformar 596 em XML_INDISPONIVEL automaticamente. O documento fica em espera com janela de 1 h entre consultas. Definir se haverá um estado terminal por tentativas é uma decisão de produto.

## 19. Conclusão

P02 e P03 estão corrigidos no código e cobertos por 21 testes determinísticos: depois de um 596 há no máximo uma consulta por janela, e o 656 de qualquer origem (consChNFe, distNSU ou 210210) alimenta o Gate existente com escopo por empresa. O bloqueio de uma empresa não interrompe sincronização, manifestação, consChNFe nem recuperação XML das outras. Um defeito antigo no lock por documento (liberado antes do fim da consulta SOAP) foi encontrado pelo teste de concorrência e corrigido. P01 tem o contrato preparado, mas a seleção de candidatos continua como antes.

A regressão da Central não tem falha nova. As 29 falhas pré-existentes continuam e não foram mascaradas.

**Nada foi validado em Produção.** A liberação das consultas reais das empresas depende de uma execução controlada, fora desta sprint, observando o Gate por empresa no painel.
