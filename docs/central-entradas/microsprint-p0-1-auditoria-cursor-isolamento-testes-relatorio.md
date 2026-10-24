# Microsprint P0.1 — Auditoria final do cursor NSU e isolamento do banco nos testes

**Prioridade:** P0 — Fiscal / Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** auditoria estática + isolamento de testes + correção da falha `100 !== 101`  
**Pré-requisito:** `docs/central-entradas/microsprint-correcao-segura-cursor-656-relatorio.md`

Nenhuma consulta DistDFe real, `consChNFe`, certificado de produção, manifestação `210210`, rewind/avanço de NSU de produção ou escrita no banco oficial foi executada. Recuperação de NF-e **não** faz parte desta microsprint. Sem commit, push ou merge.

---

## 1. Arquivos inspecionados e alterados

### Inspecionados (auditoria estática 656 / 137 / 138)

| Arquivo | Papel |
|---|---|
| `backend/motores/central-entradas/services/NsuRecoveryService.js` | Avaliação 656; nunca persiste avanço |
| `backend/motores/central-entradas/services/CentralNsuService.js` | Único escritor de cursor DistDFe |
| `backend/motores/central-entradas/repositories/CentralNsuRepository.js` | `UPDATE` atômico por `id` / `UNIQUE(cnpj, ambiente)` |
| `backend/services/fiscal/distribuicaoDFe.js` | Orquestração DistDFe: 656 antes da persistência; 137/138 depois |
| `backend/services/fiscal/DfeAuditoriaService.js` | `registrarNsuAvanco` com `nsuRemoto` / `maxNsuAnterior` |
| `backend/motores/central-entradas/config/centralEventosTipos.js` | `NSU_PRESERVADO_656`; `AUTO_SYNC_NSU` só histórico |
| `backend/motores/central-entradas/services/CentralDiagnosticoService.js` | **Somente lê** o último `AUTO_SYNC_NSU` |
| `backend/database.js` | Resolução de `DB_DIR`; rótulo interno `BANCO OFICIAL EM USO` |
| `backend/motores/central-entradas/repositories/CentralNotificacoesRepository.js` | Teto `listar()` = 100 |

### Alterados nesta microsprint (testes / isolamento)

Nenhum arquivo de produção do cursor 656 foi reaberto para correção: a política P0 permanece.

| Arquivo | Papel |
|---|---|
| `tests/central-entradas/helpers/isolarBancoTeste.js` | **Novo.** `DB_DIR` temporário + guardião sqlite3 + comprovação do caminho aberto |
| `tests/central-entradas/rc1-consolidacao.test.js` | Isolamento + asserção da notificação sem teto falso de `listar(500)` |
| `tests/central-entradas/rc2-diagnostico.test.js` | Isolamento antes de `database.js` |
| `tests/central-entradas/rc333-hardening.test.js` | Isolamento |
| `tests/central-entradas/rc3751-nsu-recovery.test.js` | Isolamento + `comprobarSeCarregado` no `main` |
| `tests/central-entradas/rc3752-nsu-preservacao.test.js` | Idem |
| `tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js` | Isolamento + teste-guardião que recusa `ProgramData` |
| `tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js` | Isolamento |
| `tests/central-entradas/central-entradas-sprint{2,4,5,7,8,10}.test.js` | Isolamento da suíte `test:central-entradas` |

Alterações locais preexistentes fora desta lista **não** foram desfeitas.

---

## 2. Caminhos concretos que poderiam alterar o cursor

Rastreamento por chamada, sem presumir que os testes já provam o ponto.

### 2.1 Escritor único

Toda persistência de `ult_nsu` / `max_nsu` DistDFe passa por `CentralNsuRepository.atualizarSincronizacaoSegura`. `atualizarSincronizacao` é alias. `CentralNsuService.aplicarRetornoDistDfe` é o único chamador de produção do avanço.

`NsuRecoveryService.tentarRecuperar` **não** chama o repositório para gravar NSU. Retorno fixo: `atualizou: false`. `nsuAtualizado` / `maxNsuAtualizado` devolvem os valores **locais**.

Não há `emitirEvento({ tipo: AUTO_SYNC_NSU })` em nenhum serviço de backend. O enum permanece; `CentralDiagnosticoService` só consulta o último evento histórico.

### 2.2 Caminho `cStat 656` (não avança)

```
distribuicaoDFe.sincronizarDistribuicaoDFe
  └─ cStat === '656'  (antes de persistirDocumentosRetorno)
       ├─ nsuService.aplicarRetornoDistDfe({ cStat: '656' })
       │    ├─ recovery.tentarRecuperar(...)          // auditoria; atualizou=false
       │    └─ repo.atualizarSincronizacaoSegura({
       │         preservarNsu: true,                   // NÃO toca ult_nsu/max_nsu
       │         ultimoCstat: '656',
       │         cooldownAte: agora+1h
       │       })
       │    └─ return { atualizouNsu: false }
       ├─ auditoria.registrarNsuAvanco({ avancou: false, nsuRemoto, maxNsuAnterior })
       └─ return { codigo: 'CONSUMO_INDEVIDO', nsuRecuperado: false }
```

`preservarNsu: true` monta `UPDATE ... SET data_sincronizacao, ultimo_cstat, cooldown_ate, updated_at WHERE id = ?`. Colunas `ult_nsu` e `max_nsu` **não entram no SQL**.

Motivos emitidos por `tentarRecuperar` (nenhum persiste cursor):

| Motivo | Quando |
|---|---|
| `SEM_ULT_NSU` | tags ausentes |
| `SEFAZ_NAO_MAIOR` | remoto ≤ local |
| `NSU_REMOTO_INCONSISTENTE` | max=0 ou max < ult (inclui o caso que zerava max) |
| `AVANCO_656_BLOQUEADO` | par remoto “válido” e maior — **mesmo assim não avança** (RC3.7.5.1 revogado) |
| `JA_PROCESSADO` | cache da avaliação; sem persistência extra |

Evento `NSU_PRESERVADO_656` é emitido em `_auditarPreservacao` com `nsuLocal`, `nsuRemoto`, `maxLocal`, `maxNsu`, `motivo`, origens Parser/Fallback XML, `correlationId`. Resultado `PRESERVADO`. Não é emitido quando o remoto não seria um salto (`SEFAZ_NAO_MAIOR` / `SEM_ULT_NSU`).

### 2.3 RC3.7.5.1 não restaura o salto automático

O cenário “banco restaurado, SEFAZ à frente, 656 com par consistente” cai em `AVANCO_656_BLOQUEADO`. Não há `if (remoto > local) atualizarSincronizacaoSegura({ ultNsu })`. Fallback XML (`NSU_RECOVERED_FROM_XML`) também não grava cursor.

### 2.4 Caminho `137` / `138` (avança só depois da persistência)

```
distribuicaoDFe  (cStat 137 ou 138)
  ├─ persistirDocumentosRetorno(...)
  ├─ se errosPersistencia.length > 0
  │     return PERSISTENCIA_DFE_INCOMPLETA   // NSU local inalterado
  └─ nsuService.aplicarRetornoDistDfe({ cStat 137|138, ult, max })
       ├─ tags ausentes            → preservarNsu
       ├─ candidataUlt < atualUlt  → preservarNsu (NSU_REJEITAR_REGRESSAO)
       ├─ max=0 após progresso ou max < ult → preservarNsu (NSU_REJEITAR_PAR_INCONSISTENTE)
       └─ senão atualizarSincronizacaoSegura({ ultNsu, maxNsu })  // único avanço
```

O `CASE` SQL no repositório é a segunda trava, atômica no mesmo `UPDATE`:

- `ult_nsu` só muda se `novo ≥ atual` **e** `max ≠ 0` **e** `max ≥ ult`.
- `max_nsu` com candidato `0` **preserva** o max existente.
- `UPDATE ... WHERE id = ?` — uma linha, um CNPJ+ambiente.

### 2.5 Isolamento entre empresas / filiais

A tabela **não** tem `empresa_id`. A chave é `UNIQUE(cnpj, ambiente)`. DistDFe é por CNPJ emitente, não por `empresaId` interno.

- `obterOuCriar(cnpj, ambiente)` e `buscarPorCnpjAmbiente` não usam fallback de outra empresa.
- `UPDATE WHERE id = ?` não espalha valor global.
- 656 na Matriz não altera Filial 2 / Filial 3 (CNPJs distintos). Comprovado no teste isolado `:memory:`.
- Não há recuperação implícita que recua o cursor: regressão é rejeitada; 656 usa `preservarNsu`.

**Limitação residual (não é rota 656):** `obterUltimaSincronizacao()` lê `ORDER BY data LIMIT 1` sem filtro de CNPJ — diagnóstico, não escrita. O método legado `repository.atualizar(id, dados)` monta `SET` genérico sem `CASE`; nenhum caminho 656/137/138 o chama.

---

## 3. Evidências de que `656` não avança o NSU

| Evidência | Onde |
|---|---|
| `tentarRecuperar` nunca chama o repositório com novo NSU | `NsuRecoveryService.js` retorno `atualizou: false` |
| Ramo 656 de `aplicarRetornoDistDfe` usa só `preservarNsu: true` e devolve `atualizouNsu: false` | `CentralNsuService.js` ~114–174 |
| DistDFe 656 não chama `persistirDocumentosRetorno` e audita `avancou: false` | `distribuicaoDFe.js` ~820–903 |
| Nenhum `emit` de `AUTO_SYNC_NSU` no backend | grep em `backend/**/*.js`: só enum + leitura no diagnóstico |
| RC3.7.5.1 (restore + remoto maior) agora afirma preservação | `rc3751-nsu-recovery.test.js` — 9/0 |
| 656 + max=0 preserva max local | teste `:memory:` + RC3.7.5.1 caso max0 |
| Isolamento Matriz / Filial 2 / Filial 3 | `microsprint-correcao-segura-cursor-656.test.js` |
| DistDFe 656 simulado: `nsuRecuperado=false`, motivo `CONSUMO_INDEVIDO` | mesmo arquivo, SOAP mock |

---

## 4. Isolamento dos testes — banco realmente aberto

O rótulo `BANCO OFICIAL EM USO:` em `database.js` **não** significa ProgramData. Ele imprime `DB_PATH` após resolver `process.env.DB_DIR`. Com o helper, esse caminho é sempre `%TEMP%\…\mercadao.db`.

### Mecânica

1. Primeira linha executável do teste: `isolarBancoTeste(prefixo)` — cria `DB_DIR` em `os.tmpdir()` **antes** de qualquer `require` de `database.js`.
2. Guardião em `sqlite3.Database` / `sqlite3.verbose()` recusa qualquer filename que case `ProgramData\MercantilFiscal\dados`.
3. `comprobar(db)` exige `db.dbPath` (conexão real) igual ao diretório isolado; falha se divergir.
4. Teste-guardião: `new sqlite3.Database('C:\\ProgramData\\MercantilFiscal\\dados\\mercadao.db')` lança `Teste isolado recusou abrir o banco oficial`.

`DB_DIR` e `CDS_FORCAR_LOCAL` estavam **vazios** no shell pai antes da suíte. Cada processo Node criou o próprio temporário. Nenhum teste isolado abriu `C:\ProgramData\MercantilFiscal\dados`.

### Caminhos comprovados nesta execução

| Suíte | Banco realmente aberto |
|---|---|
| RC3.7.5.1 | `database.js` **não carregado** (repositório em memória) |
| RC3.7.5.2 | idem |
| RC3.7.5.3 | sem `database.js` (UX puro) |
| cursor 656 (NSU) | SQLite `:memory:` |
| cursor 656 (DistDFe / mutex) | `C:\Users\cicer\AppData\Local\Temp\cds-cursor-656-R07ccw\mercadao.db` |
| cooldown DistDFe | `C:\Users\cicer\AppData\Local\Temp\cds-audit-cooldown-LJJyIW\mercadao.db` |
| RC3.3.3 | `C:\Users\cicer\AppData\Local\Temp\ce-rc333-25Hj1V\mercadao.db` (`BANCO DE TESTE COMPROVADO`) |
| sprint2 | `...\Temp\ce-sprint2-4EEtkh\mercadao.db` |
| sprint4 | `...\Temp\ce-sprint4-SGYlBA\mercadao.db` |
| sprint5 | `...\Temp\ce-sprint5-L1CYQO\mercadao.db` |
| sprint7 | `...\Temp\ce-sprint7-aU03hp\mercadao.db` |
| sprint8 | `...\Temp\ce-sprint8-Z1cvxD\mercadao.db` |
| sprint9 | não carrega `database.js` |
| sprint10 | `...\Temp\ce-sprint10-ZKUzBy\mercadao.db` |
| RC1 | `...\Temp\ce-rc1-LWN2b8\mercadao.db` |
| RC2 | `...\Temp\ce-rc2-ulIRDe\mercadao.db` |

Grep no log de `npm run test:central-entradas`: **zero** ocorrências de `ProgramData\MercantilFiscal`.

---

## 5. Falha `100 !== 101` — causa e resolução

### Origem dos registros

`CentralNotificacoesService.listar({ limite })` delega a `CentralNotificacoesRepository.listar`, que aplica:

```js
const limite = Math.min(Number(filtros.limite) || 30, 100);
```

`limite: 500` **nunca** retorna 500 linhas. O teto duro é 100, ordenado por `created_at DESC, id DESC`, sem filtro de teste.

Na execução anterior contra o banco oficial, a tabela `central_entradas_notificacoes` já tinha **≥ 100** linhas residuais (produção / sessões anteriores). `antes.length === 100`. Após `notificarSyncConcluida`, `depois.length` continuava 100 (ainda no teto). A asserção `100 === 101` falhava.

Isso **não** prova que a operação deixou de criar a notificação, nem que criou 101. Prova que o teste media a página capada, não o efeito da operação.

Não é dependência de ordem **dentro** da suíte isolada: o banco temporário nasce vazio. A dependência era com **resíduo do banco oficial**.

### A expectativa “uma notificação por sync” é válida

`notificarSyncConcluida({ notasNovas: 4, sucesso: true })` deve inserir **uma** linha `NOVAS_NOTAS`. Isso é a regra RC1. O defeito estava no **oráculo** (`listar` com teto 100 + banco sujo), não na implementação.

Não se alterou o teto de `listar` nem a expectativa de cardinalidade da operação.

### Correção no teste (banco isolado)

1. Isolar `rc1` em `%TEMP%\ce-rc1-*\mercadao.db` **antes** de carregar `database.js`.
2. Guardar `antes.length < 100` — se o isolado já estivesse no teto, o teste falha de forma explícita (não mascara).
3. Asserir a linha criada (`id`, `tipo`, mensagem com “4 novas notas fiscais”).
4. `depois.length === antes.length + 1` e `depois[0].id === criada.id`.
5. `contarNaoLidas()` (COUNT sem teto) incrementa 1.

Resultado nesta execução: **OK** `notificação de sync consolidada — uma por sincronização`. RC1: **9 passou, 0 falhou**.

Não é pendência.

---

## 6. Resultados dos testes

Comandos exatos (cwd `C:\projetos\CDS-SISTEMAS PASTELARIA`). SOAP DistDFe mockado; sem PFX de produção.

| Comando | Resultado | Banco |
|---|---|---|
| `node tests/central-entradas/rc3751-nsu-recovery.test.js` | **9 ok, 0 falha** | sem `database.js` |
| `node tests/central-entradas/rc3752-nsu-preservacao.test.js` | **7 ok, 0 falha** | sem `database.js` |
| `node --test tests/central-entradas/rc3753-ux-cooldown-656.test.js` | **7 pass, 0 fail** | sem banco |
| `node --test tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js` | **15 pass, 0 fail** (14 P0 + guardião) | `:memory:` + Temp `cds-cursor-656-*` |
| `node --test tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js` | **12 pass, 0 fail** | Temp `cds-audit-cooldown-*` |
| `node tests/central-entradas/rc333-hardening.test.js` | **6 passou, 0 falhou** | Temp `ce-rc333-*` comprovado |
| `npm run test:central-entradas` | **exit 0** | ver tabela da seção 4 |

Detalhe `test:central-entradas`:

| Arquivo | Resultado |
|---|---|
| `maquina-estados.test.js` | 11 passou, 0 falhou |
| `central-entradas-sprint2.test.js` | 8 passou, 0 falhou |
| `central-entradas-sprint4.test.js` | 5 passou, 0 falhou |
| `central-entradas-sprint5.test.js` | 7 passou, 0 falhou |
| `central-entradas-sprint7.test.js` | 11 passou, 0 falhou |
| `central-entradas-sprint8.test.js` | 8 passou, 0 falhou |
| `central-entradas-sprint9.test.js` | 7 passou, 0 falhou |
| `central-entradas-sprint10.test.js` | 7 passou, 0 falhou |
| `rc1-consolidacao.test.js` | 9 passou, 0 falhou |
| `rc2-diagnostico.test.js` | 9 passou, 0 falhou |

Nenhum teste foi desabilitado.

---

## 7. Limitações restantes

1. Isolamento desta microsprint cobre a suíte `test:central-entradas`, RC3.3.3, RC3.7.5.x, cursor 656 e cooldown DistDFe. Outros testes da Central que ainda carregam `database.js` sem o helper **não** foram varridos aqui — não executá-los contra o banco oficial até o mesmo padrão.
2. Chave NSU continua `UNIQUE(cnpj, ambiente)`, não `empresa_id`. Filiais com CNPJ distinto estão isoladas; duas “empresas” internas no mesmo CNPJ compartilhariam o cursor (modelo DistDFe).
3. `obterUltimaSincronizacao()` e `repository.atualizar()` genérico permanecem como superfície residual **fora** do caminho 656 — sem caller atual nesse fluxo.
4. `salvarXmlRetorno656` pode gravar XML de **mock** em `dados/fiscal/debug` do repositório (`getFiscalDir()`), não em ProgramData. Não é o banco oficial.
5. O banner `BANCO OFICIAL EM USO` em `database.js` continua semanticamente enganoso; o caminho impresso é o `DB_PATH` efetivo. A comprovação é `BANCO DE TESTE COMPROVADO` + `db.dbPath`.
6. DistDFe / `consChNFe` reais, certificado de produção e recuperação de NF-e de outubro **não** foram executados — de propósito.

---

## 8. Confirmação operacional

| Controle | Situação |
|---|---|
| SOAP DistDFe / `consChNFe` contra SEFAZ | não executados |
| Certificado PFX de produção para transmissão | não aberto |
| Manifestação 210210 | não enviada |
| `ult_nsu` / `max_nsu` do banco oficial | não lidos nem escritos por esta suíte |
| Banco `C:\ProgramData\MercantilFiscal\dados` | recusado pelo guardião; nenhum teste isolado o abriu |
| Recuperação de NF-e | não iniciada |
| Git commit / push / merge / comandos destrutivos | não executados |
| Alterações locais preexistentes | preservadas |

---

## Critérios de conclusão

| Critério | Estado |
|---|---|
| Nenhuma rota indevida de avanço do cursor identificada sem tratamento | Atendido — 656 só `preservarNsu`; RC3.7.5.1 revogado; 137/138 após persistência + par válido |
| Suíte executada em banco isolado, com caminho real comprovado | Atendido |
| Falha `100 !== 101` explicada por evidência | Atendido — teto 100 + resíduo oficial; corrigido no teste isolado, não na expectativa de negócio |
| Relatório sem commit/push/merge | Atendido |
