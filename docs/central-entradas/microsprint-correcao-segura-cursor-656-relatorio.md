# Microsprint P0 — Correção segura do cursor em cStat 656

**Prioridade:** P0 — Fiscal / Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** correção de regra + testes isolados  
**Auditoria de origem:** `docs/central-entradas/auditoria-intervalo-nfe-2026-09-28-a-2026-10-17.md`

Nenhuma DistDFe real, `consChNFe`, certificado de produção, rewind de NSU ou manifestação 210210 foi executada. Recuperação de NF-e possivelmente puladas **não** faz parte desta microsprint.

---

## 1. Causa técnica

A auditoria do intervalo 28/09–17/10 comprovou 11 eventos `AUTO_SYNC_NSU`. Em `NsuRecoveryService.tentarRecuperar`, cStat 656 avançava `ult_nsu` quando o `ultNSU` do parser/XML era maior que o local — inclusive com `maxNSU=0` e **sem** lote DistDFe, ZIP, parser ou persistência.

Dois defeitos combinados:

1. **Política:** 656 (rejeição de consumo indevido) era tratado como fonte de cursor, no cenário RC3.7.5.1 “banco restaurado”.
2. **Persistência:** `atualizarSincronizacaoSegura` gravava `max_nsu` quando o *ult* candidato era ≥ ao ult local (`CASE WHEN ? >= ult_nsu THEN ?`), permitindo `max_nsu=0`.

Não havia condição segura: o avanço não dependia de 137/138 nem de persistência durável.

---

## 2. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/motores/central-entradas/services/NsuRecoveryService.js` | 656 só avalia e audita; **nunca** persiste avanço |
| `backend/motores/central-entradas/services/CentralNsuService.js` | 656 = preservar NSU + cooldown 1 h; 137/138 rejeitam par inconsistente / max=0 após progresso |
| `backend/motores/central-entradas/repositories/CentralNsuRepository.js` | `CASE` atômico: ult só avança com par consistente; max=0 não zera progresso |
| `backend/services/fiscal/distribuicaoDFe.js` | ramo 656 força `avancou=false`, motivo `CONSUMO_INDEVIDO`, sem `AUTO_SYNC` |
| `backend/services/fiscal/DfeAuditoriaService.js` | detalhe de NSU inclui `nsuRemoto` / `maxNsuAnterior` |
| `backend/motores/central-entradas/config/centralEventosTipos.js` | tipo `NSU_PRESERVADO_656`; `AUTO_SYNC_NSU` permanece só para histórico |
| `tests/central-entradas/rc3751-nsu-recovery.test.js` | expectativas alinhadas à regra segura |
| `tests/central-entradas/rc3752-nsu-preservacao.test.js` | idem (fallback XML não avança) |
| `tests/central-entradas/rc3753-ux-cooldown-656.test.js` | stub de `navigator.onLine` no Node |
| `tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js` | cobertura P0 (SQLite `:memory:`, SOAP mock) |
| `package.json` | script `test:central-entradas-cursor-656` |

Alterações locais preexistentes em outros arquivos **não** foram desfeitas. Sem commit, push ou merge.

---

## 3. Comportamento anterior × novo

| Situação | Antes | Agora |
|---|---|---|
| 656 com `ultNSU` remoto > local e `maxNSU=0` | `AUTO_SYNC` saltava o ult e podia zerar max | Cursor e max preservados; evento `NSU_PRESERVADO_656`; motivo `NSU_REMOTO_INCONSISTENTE` |
| 656 com par remoto “válido” (max ≥ ult > local) | `AUTO_SYNC` avançava (RC3.7.5.1) | Mesmo bloqueio; motivo `AVANCO_656_BLOQUEADO` |
| 656 com valores iguais ou menores | Preservava | Preserva (`SEFAZ_NAO_MAIOR`) |
| 656 sem tags | Preservava | Preserva (`SEM_ULT_NSU`) |
| Cooldown 656 | 1 hora | 1 hora (`cooldown_ate`); Gate/mutex/fila intactos |
| Evento `AUTO_SYNC_NSU` | `ATUALIZADO` no salto | **Não emitido** no caminho 656 |
| 137/138 com par consistente, após persistência | Avança | Avança |
| 137/138 com persistência incompleta | NSU não avança | Inalterado |
| 137/138 com max=0 após progresso, ou max < ult | Podia gravar par ruim | Preserva o cursor local |

---

## 4. Política final para cStat 656

656 **não** atualiza `ult_nsu` nem `max_nsu`.

Efeitos permitidos:

- `ultimo_cstat = 656`
- `cooldown_ate = agora + 1 h`
- auditoria DistDFe `NSU_PRESERVADO` / resumo `CONSUMO_INDEVIDO`
- evento central `NSU_PRESERVADO_656` quando o remoto seria um salto (rastreio da discrepância)

Condição **segura** para avançar o cursor continua sendo somente DistDFe **137 ou 138** com:

- tags `ultNSU` e `maxNSU` presentes;
- par consistente (`max ≠ 0` e `max ≥ ult`);
- persistência de documentos **já concluída** sem `errosPersistencia`.

Não se assume que “todo 656 é lixo”: o XML continua parseado para logar o que a SEFAZ informou. Esse valor **não** vira cursor.

---

## 5. Compatibilidade com RC3.7.5.1

O cenário original (“banco restaurado, SEFAZ à frente”) **conflita** com a evidência de pulo de NSU em produção.

**Decisão:** revogar o avanço automático. A restauração de backup, se ocorrer, não se corrige com DistDFe 656. Documentos atrasados exigem etapa posterior: `consChNFe` com chaves do cliente e homologação autorizada — sem recuar NSU.

Rastreabilidade do comportamento antigo:

- tipo `AUTO_SYNC_NSU` permanece no enum (eventos já gravados em produção);
- testes RC3.7.5.1/RC3.7.5.2 descrevem o cenário de restore e agora **afirmam** preservação, não salto;
- motivo `AVANCO_656_BLOQUEADO` documenta que o remoto era maior e mesmo assim não foi aplicado.

Não há exceção “se remoto > local então avança”.

---

## 6. Testes executados e resultados reais

Isolamento dos testes desta microsprint: SQLite `:memory:` ou `DB_DIR` temporário, `enviarDistribuicaoDfe` mock, sem PFX real.

| Comando | Resultado |
|---|---|
| `node tests/central-entradas/rc3751-nsu-recovery.test.js` | **9 ok, 0 falha** |
| `node tests/central-entradas/rc3752-nsu-preservacao.test.js` | **7 ok, 0 falha** |
| `node --test tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js` | **14 pass, 0 fail** |
| `node tests/central-entradas/rc333-hardening.test.js` | **6 passou, 0 falhou** |
| `node --test tests/central-entradas/rc3753-ux-cooldown-656.test.js` | **7 pass, 0 fail** (após stub de `navigator.onLine` no Node) |
| `node --test tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js` | **12 pass, 0 fail** |
| `npm run test:central-entradas` | suíte preexistente: última peça `rc1-consolidacao` **8 passou, 1 falhou** |

### Cobertura obrigatória (arquivo novo)

- 656 remoto maior + max=0 → preserva  
- 656 max < ult → preserva  
- 656 igual ao local → sem avanço  
- 656 repetido após `limparCacheEventos` → cursor íntegro  
- max válido não zerado pelo `CASE`  
- cooldown 1 h + motivo  
- ausência de `AUTO_SYNC_NSU`  
- isolamento Matriz / Filial 2 / Filial 3  
- 137/138 avançam; 137 restaura max zerado sem recuar ult  
- 138 com falha SQLITE não chama avanço de NSU  
- DistDFe 656 simulado: `nsuRecuperado=false`, motivo `CONSUMO_INDEVIDO`  
- concorrência 656+138 no mesmo CNPJ não deixa max=0  
- mutex DistDFe: uma execução efetiva  

### Falha remanescente da suíte `test:central-entradas`

`rc1-consolidacao.test.js` — *notificação de sync consolidada — uma por sincronização*: `100 !== 101` em `listar({ limite: 500 })`. Não envolve cursor, 656, `AUTO_SYNC` nem os arquivos desta correção. O harness dessa suíte carrega `database.js` e imprime o caminho de `mercadao.db`; o teste de notificação conta linhas já existentes (teto aparente de 100). **Não** foi desabilitado. Não é regressão da regra 656.

O teste UX 656 falhou uma vez no Node (`navigator.onLine` ausente/`false` → `offline`). A lógica de cooldown não mudou; o teste foi tornado hermético com `navigator.onLine=true`. 7/7 na reexecução.

---

## 7. Isolamento operacional desta microsprint

| Controle | Situação |
|---|---|
| SOAP DistDFe / `consChNFe` | não executados contra SEFAZ |
| Certificado PFX de produção | não aberto para transmissão |
| NSU de produção | não recuado, zerado nem avançado por esta correção (só código + testes) |
| Manifestação 210210 | não enviada |
| Migrations / recálculos solicitados | não disparados como rotina desta sprint |
| Gate / mutex / fila / rate limiter / circuit breaker | preservados |
| Git commit / push / merge | não executados |

**Nota sobre a suíte preexistente:** `npm run test:central-entradas` e `rc333-hardening.test.js` imprimem `BANCO OFICIAL EM USO` porque o harness antigo exige `database.js` sem `DB_DIR`. Isso é o comportamento já existente desses testes, não uma escrita de cursor 656. A prova da regra nova está nos testes `:memory:` / `DB_DIR` temporário.

Nenhum `UPDATE` de `ult_nsu`/`max_nsu` de produção foi emitido por esta microsprint.

---

## 8. Pendências de homologação operacional

1. **Não consultar a SEFAZ ainda** para “recuperar outubro”. DistDFe no cursor atual só vê o topo (196 / 045 / 035).
2. Colher **chaves de acesso** dos DANFEs de outubro com o cliente.
3. Sprint seguinte, autorizada: `consChNFe` controlado, sem rewind de NSU, com Gate/cooldown.
4. Depois da correção em execução real: DistDFe no topo para documentos **novos**, confirmando que 656 preserva o cursor.
5. Filial 3 com `max_nsu=0` em produção só se corrige na próxima **137/138 válida** (teste isolado já cobre a restauração do max). Não forçar UPDATE no banco oficial.

---

## Critérios de aceitação

| Critério | Estado |
|---|---|
| Nenhum caminho 656 avança só porque o `ultNSU` remoto é maior | Atendido |
| `max_nsu` válido não é zerado por 656 | Atendido |
| Testes de regressão, isolamento e persistência | 14 novos + RC3.7.5.1/2/3 + cooldown + hardening |
| Suíte Central | 1 falha preexistente/isolada em notificação RC1, discriminada acima |
| Alterações locais preexistentes preservadas | Atendido |
| Relatório sem commit/push/merge | Atendido |
