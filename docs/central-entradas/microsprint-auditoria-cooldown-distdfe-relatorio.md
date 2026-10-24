# Auditoria do cooldown e do estado da fila DistDFe

**Prioridade:** P0 — Crítica  
**Data:** 17/10/2026  
**Módulo:** Central de Entradas / Distribuição DF-e  
**Tipo:** auditoria com correção condicionada a evidências  
**Ambiente:** testes isolados, **sem** comunicação real com a SEFAZ

Esta microsprint **não** homologou DistDFe com SEFAZ real, **não** abriu o banco oficial `C:\ProgramData\MercantilFiscal\dados`, **não** usou certificado de produção, **não** forçou liberação de cooldown em produção, **não** alterou NSU de produção e **não** enviou manifestação 210210.

---

## 1. Causa raiz comprovada

A mensagem reportada:

`Erro na sincronização: Consulta DF-e não executada: fila DistDFe esgotada (ultNSU = maxNSU). Nova consulta após a janela de 1 hora.`

**não** prova, isoladamente, que não existem NF-e novas na SEFAZ. Também **não** prova que o cooldown de uma hora esteja indevido.

### 1.1 O que está correto (não foi contornado)

A janela de 1 hora `FILA_ESGOTADA` é a regra local esperada após uma resposta DistDFe **válida** com:

- `cStat` 137 ou 138;
- `ultNSU = maxNSU`;
- `data_sincronizacao` gravada nesse apply.

Isso corresponde à NT 2014.002: a fila daquele CNPJ/ambiente foi varrida até o topo **naquele momento**. Nova `distNSU` imediata seria consumo indevido. A microsprint **não** removeu esse bloqueio.

### 1.2 Defeitos comprovados e corrigidos

| Defeito | Evidência | Correção |
|---|---|---|
| A UI/notificação tratava o bloqueio como **erro de sincronização** | `CentralNotificacoesService.notificarSyncConcluida` usava `SYNC_ERRO` + título `Erro na sincronização` sempre que `sucesso === false`. O poll da Central concatena `titulo + ': ' + mensagem`. | Consulta ignorada / não enviada gera `SYNC_CONSULTA_NAO_ENVIADA` com título `Consulta DF-e não enviada`. |
| A mensagem omitia o horário real de liberação | Texto fixo “após a janela de 1 hora”, embora `avaliarCooldown` já calculasse `proximaConsultaEm`. | `montarMensagemCooldown` inclui o ISO de liberação. A UI formata esse instante. |
| Preserve de NSU **renovava** `data_sincronizacao` | `atualizarSincronizacaoSegura({ preservarNsu: true })` sempre gravava `data_sincronizacao = agora`. Resposta inválida, regressão ou zero após progresso podia **estender** `FILA_ESGOTADA` sem apply válido de 137/138. | `manterDataSincronizacao: true` nesses percursos. 656 continua atualizando `cooldown_ate` (motivo `COOLDOWN_EXPLICITO`). |

Gate, mutex, falha de rede e falha de persistência **não** iniciam `FILA_ESGOTADA`: não chamam `aplicarRetornoDistDfe` com cStat 137/138 persistido.

---

## 2. Caminho exato da mensagem

1. Operador abre a Central ou clica em **Sincronizar**.
2. `CentralSyncExecucaoService.executar` emite `CONSULTA_SOLICITADA`.
3. Em EMPRESA_SIMPLES, `_verificarCooldownDfe` lê `central_entradas_nsu` (CNPJ + ambiente) e chama `CentralNsuService.avaliarCooldown`.
4. Em MULTIEMPRESA, o cooldown global de `executar()` é pulado; o bloqueio ocorre em `CentralSincronizacaoService._sincronizarEmpresa` **por CNPJ**.
5. Se `cooldown.ativo` e `motivo === 'FILA_ESGOTADA'`:
   - emite `BLOQUEADA_COOLDOWN`;
   - devolve `consultaExecutada: false`, `ignorado: true`, `codigo: 'AGUARDAR_JANELA_DFE'`;
   - **não** chama `enviarDistribuicaoDfe`.
6. Antes desta sprint, a notificação consolidada prefixava `Erro na sincronização:`. O texto interno era o genérico de 1 hora.
7. `frontend/erp/js/central-entradas.js` `pollNotificacoesCentral` montava exatamente a string reportada quando `tipo === 'SYNC_ERRO'`.

O botão Sincronizar já distinguia `consultaIgnorada` com `warning`. A abertura suave também. O prefixo de **erro** vinha da notificação persistida.

---

## 3. Condição que inicia a janela de 1 hora

Função: `CentralNsuService.avaliarCooldown`  
Constante: `INTERVALO_COOLDOWN_MS = 60 * 60 * 1000`

### 3.1 `COOLDOWN_EXPLICITO`

Aplicado quando existe `cooldown_ate` futuro. Origem normativa: cStat **656** em `aplicarRetornoDistDfe` (`cooldownAte = agora + 1h`).

### 3.2 `FILA_ESGOTADA`

Aplicado quando **todas** as condições locais valem:

1. `ult_nsu === max_nsu` (strings persistidas);
2. `ultimo_cstat` ∈ {137, 138};
3. `data_sincronizacao + 1h` ainda no futuro.

`proximaConsultaEm = data_sincronizacao + 1h`.

`ultNSU = maxNSU` **sozinho** não basta (cStat 656 sem `cooldown_ate` não entra neste ramo).

### 3.3 O que **não** inicia nem deve renovar a janela

| Evento | SOAP? | `aplicarRetorno` 137/138? | Efeito no cooldown |
|---|---|---|---|
| Gate negado | Não | Não | Nenhum |
| Mutex `SYNC_EM_ANDAMENTO` | Não | Não | Nenhum |
| Cooldown vigente | Não | Não | Mantém o existente |
| Falha de rede / corpo inválido | Tentativa ou erro | Não (exceção) | Não inicia |
| Persistência `ERRO_BANCO` | Sim | Não (NSU preservado) | Não inicia |
| Resposta 137/138 com ult=max persistida | Sim | Sim | Inicia `FILA_ESGOTADA` |
| Resposta 656 | Sim | Preserve + `cooldown_ate` | `COOLDOWN_EXPLICITO` |
| Resposta inválida / regressão / zero após progresso | Sim, se chegou | Preserve **sem** renovar `data_sincronizacao` | Não estende `FILA_ESGOTADA` |

---

## 4. Estado de NSU usado na decisão

Tabela: `central_entradas_nsu`  
Chave: `UNIQUE(cnpj, ambiente)`

| Campo | Papel |
|---|---|
| `ult_nsu` / `max_nsu` | Cursor DistDFe. Nunca regride. Não avança antes da persistência necessária. |
| `ultimo_cstat` | Distingue fila esgotada (137/138) de 656 e de falha. |
| `data_sincronizacao` | Base da janela `FILA_ESGOTADA`. |
| `cooldown_ate` | Base da janela `COOLDOWN_EXPLICITO` (656). |

Sobrevivência à reinicialização: os dois timestamps estão no SQLite. Um novo processo relê o controle e `avaliarCooldown` reproduz o bloqueio até expirar.

Isolamento: empresa A em cooldown **não** impede SOAP da empresa B (mesmo ambiente, outro CNPJ).

---

## 5. Arquivos alterados e justificativa

| Arquivo | Por quê |
|---|---|
| `backend/motores/central-entradas/services/CentralNsuService.js` | `montarMensagemCooldown`; preserve inválido/regressão/zero com `manterDataSincronizacao`. |
| `backend/motores/central-entradas/repositories/CentralNsuRepository.js` | `preservarNsu` só atualiza `data_sincronizacao` quando a janela deve ser gravada. |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Mensagem + `mensagemAmigavel` + `proximaConsultaEm` no resultado agregado. |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | Mesma mensagem; notificação recebe `ignorado` / `consultaExecutada`. |
| `backend/motores/central-entradas/services/CentralNotificacoesService.js` | Bloqueio ≠ `SYNC_ERRO`. |
| `backend/motores/central-entradas/contracts/SincronizacaoResultadoDTO.js` | Propaga `proximaConsultaEm`. |
| `frontend/erp/js/central-entradas.js` | `montarMensagemConsultaNaoEnviadaCentral`; poll trata `SYNC_CONSULTA_NAO_ENVIADA` como aviso. |
| `tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js` | 12 cenários com mock no ponto de envio. |
| `docs/central-entradas/microsprint-auditoria-cooldown-distdfe-relatorio.md` | Este relatório. |

**Não alterados de propósito:** Gate, mutex, fila, rate limiter, circuit breaker, `sync_ao_abrir`, scheduler, regras fiscais/estoque, avanço/reset de NSU.

Alterações locais preexistentes (2.6–2.8, CNPJ, abertura, conciliação, fiscal/vendas) foram preservadas. Sem commit, push ou merge.

---

## 6. Testes executados e resultados

Todos com `CDS_FORCAR_LOCAL=1` e `DB_DIR` em diretório temporário. Nenhum teste enviou SOAP real. Endpoint mock: `https://example.invalid/dfe`.

| Suíte | Resultado |
|---|---|
| `node --test tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js` | 12 passou, 0 falhou |
| `npm run test:central-entradas` | todas as partes 0 falhou |
| Gate `tests/central-entradas/central-entradas-04-gate.test.js` | 21 ok, 0 falha |
| DistDFe 05.43 `tests/fiscal/distdfe-blindagem-05-43.test.js` | incluído no lote `--test` 24/0 |
| Abertura `tests/central-entradas/auditoria-consumo-abertura-central.test.js` | incluído no lote `--test` 24/0 |
| `tests/central-entradas/nfe-nao-localizada-sync.test.js` | incluído no lote `--test` 24/0 |
| RC3.3 `tests/central-entradas/rc33-fechamento-ciclo-dfe.test.js` | 11 passou, 0 falhou |
| RC3.3.3 `tests/central-entradas/rc333-hardening.test.js` | 6 passou, 0 falhou |

Lote `--test` (abertura + NF-e ausente + 05.43): **24 passou, 0 falhou**.

### 6.1 Os 12 cenários (interceptando o envio)

1. Fila esgotada após 137 válido `ult=max`: 1 SOAP; segundo pedido bloqueado, `consultaExecutada: false`.
2. Gate: 0 SOAP.
3. Cooldown vigente: mensagem com horário de liberação; notificação `SYNC_CONSULTA_NAO_ENVIADA`.
4. Mutex: 2 solicitações, 1 SOAP, 1 `SYNC_EM_ANDAMENTO`.
5. Falha de rede: SOAP tentado, NSU inalterado, cooldown inativo.
6. Falha de persistência: consulta executada, NSU não avança, pendência permanece, cooldown não inicia.
7. Reinício durante a janela: segundo `CentralNsuService` no mesmo SQLite ainda bloqueia.
8. Expiração: após `data_sincronizacao + 1h` o SOAP volta a ser enviado.
9. Isolamento A/B: FILA_ESGOTADA de A não impede SOAP de B.
10. 137 e 138 avançam NSU; 656 usa `cooldown_ate`; regressão/inválido não renovam `data_sincronizacao`.
11. Frontend da abertura: bloqueio ≠ sucesso; um POST `sincronizar-ao-abrir`.
12. `ERRO_BANCO` aberto não é descartado; some só quando o documento existe.

---

## 7. Produção e SEFAZ

| Controle | Status |
|---|---|
| Banco oficial `C:\ProgramData\MercantilFiscal\dados` | **Não acessado** |
| Certificado de produção | **Não utilizado** |
| SOAP DistDFe real | **Não executado** |
| Liberação forçada de cooldown em produção | **Não executada** |
| Reset / recuo / avanço artificial de NSU de produção | **Não executado** |
| Manifestação 210210 | **Não enviada** |
| Gate / mutex / fila / rate limiter / circuit breaker | **Preservados** |
| `sync_ao_abrir` e scheduler | **Não desligados** |
| Git commit / push / merge / comandos destrutivos | **Não executados** |

**Declaração expressa:** não houve homologação com SEFAZ real.

O log `BANCO OFICIAL EM USO` nos testes aponta para `C:\Users\cicer\AppData\Local\Temp\cds-...` via `DB_DIR`. Não é o banco de produção.

---

## 8. Interface após a correção

A Central deve informar:

| Situação | Como aparece |
|---|---|
| Consulta solicitada | Evento `CONSULTA_SOLICITADA` (rastreio interno) |
| Bloqueada pelo Gate | `consultaExecutada: false`, aviso, sem SOAP |
| Bloqueada pelo cooldown | `Consulta DF-e não enviada à SEFAZ: ... Nova consulta a partir de <ISO>.` + horário formatado na UI |
| Enviada | `consultaExecutada: true` após `enviarDistribuicaoDfe` |
| Fila esgotada (137/138 ult=max) | Consulta **foi** enviada na última resposta válida; o **próximo** clique é bloqueio, não nova consulta |
| Falha de rede/processamento | Erro real (`SYNC_ERRO` só nesse caso) |
| Falha de persistência | `consultaExecutada: true`, NSU preservado, pendência `ERRO_BANCO` |

A interface **não** afirma que a SEFAZ foi consultada quando o Gate, o mutex ou o cooldown impediram o envio.

---

## 9. Próximos passos para homologação operacional

1. Autorizar leitura (sem UPDATE) de `central_entradas_nsu` e `dfe_auditoria` do CNPJ/ambiente reais para ver `ultimo_cstat`, `data_sincronizacao` e `cooldown_ate`.
2. Confirmar se a última linha DistDFe realmente gravada é 137/138 com `ult=max`. Se for, a janela está **correta**; esperar `proximaConsultaEm`.
3. DistDFe real só com certificado e ambiente autorizados, **depois** da expiração, sem forçar cooldown.
4. Se existirem chaves conhecidas ausentes na inbox, usar o plano de recuperação já classificado (A–E) — `distNSU` **não** recupera NSU já consumido.
5. Homologar na UI: Sincronizar durante cooldown deve mostrar aviso com horário, não “Erro na sincronização”.

---

## 10. Critérios de aceite

| # | Critério | Status |
|---|---|---|
| 1 | Origem do cooldown demonstrada por código e testes | Atendido |
| 2 | Consulta executada ≠ consulta bloqueada | Atendido |
| 3 | Janela de 1h só na condição válida (137/138 ult=max persistidos, ou 656 com `cooldown_ate`) | Atendido |
| 4 | Isolamento por CNPJ/ambiente | Atendido |
| 5 | NSU e pendências `ERRO_BANCO` íntegros | Atendido |
| 6 | Interface com motivo e horário de liberação | Atendido (código + teste de fonte; homologação visual SEFAZ **não** feita) |
| 7 | Testes isolados passaram | Atendido |
| 8 | Relatório declara ausência de homologação SEFAZ real | Atendido (esta seção 7) |
