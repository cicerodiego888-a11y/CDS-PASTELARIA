# Microsprint P0.9 — Auditoria final de segurança da operação fiscal real

**Prioridade:** P0 — Antes da primeira consulta real  
**Data:** 18/10/2026  
**Dependência:** P0.8 — Ativação controlada do fiscal real  
**Decisão final:** **APROVADA COM RESSALVAS**

Nesta auditoria **não** houve consulta DistDFe real à SEFAZ, transmissão de eventos fiscais, uso de certificado/senha de produção, alteração de NSU/cooldown em produção, acesso ao banco oficial, commit, push ou merge. A operação fiscal real **permanece desabilitada por padrão** (sem auto-habilitação).

---

## 1. Resumo executivo

Foi auditado o caminho completo de autorização de produção da Central de Entradas. Encontrou-se e corrigiu-se uma falha crítica: **desativação não invalidava imediatamente autorizações `OPERACAO_REAL` já emitidas** (ainda dentro do TTL de 15 min). Também foram reforçados vínculo CNPJ, rejeição de injeção de token pelo cliente e revalidação pré-SOAP da ativação persistida.

---

## 2. Falhas encontradas e causa

| # | Severidade | Causa | Correção |
|---|---|---|---|
| F1 | **Crítica** | `avaliarOperacaoReal` validava só o token embutido (`tokenSeed` na própria autorização). Após `desabilitar` (seed=null), tokens já emitidos continuavam válidos até expirar. | `assertAutorizacaoViva` + `exigirSeedPersistido` no pré-SOAP (`distribuicaoDFe`); desativação grava `seedRevogadoEm` e zera seed. |
| F2 | Alta | Autorização sem CNPJ vinculante — risco de reuso cruzado se empresa/contexto mudasse. | `criarAutorizacaoOperacaoReal` exige CNPJ; avaliação rejeita divergência (`CNPJ_DIVERGENTE`). |
| F3 | Média | Body do cliente poderia tentar enviar `autorizacaoTransmissaoSefaz`/`token`. | Rota `consultar-dfe` rejeita com `AUTORIZACAO_CLIENTE_RECUSADA`. |
| F4 | Baixa (doc) | SOAP já em voo não pode ser abortado no meio do transporte. | Documentado: novas iterações/pré-SOAP falham após revogação; resposta oficial ainda governa NSU da chamada já iniciada. |

Não foi encontrado bypass por variável de ambiente, nem rota DistDFe sem `autorizacaoTransmissaoSefaz`.

---

## 3. Rotas de transmissão auditadas

| Rota / entrada | SOAP DistDFe? | Barreira | Observação |
|---|---|---|---|
| `POST /operacao-fiscal-real/consultar-dfe` | Sim (se autorizado) | Emitir + assert vivo + `exigirAutorizacao` + assert pré-SOAP | Único caminho HTTP OPERACAO_REAL |
| `POST /operacao-fiscal-real/habilitar` | Não | Admin + confirmações + pré-voo | Não transmite |
| `POST /operacao-fiscal-real/desabilitar` | Não | Admin | Revoga seed |
| `GET /operacao-fiscal-real/status` | Não | — | Pré-voo local |
| `POST /sincronizar` | Bloqueado sem auth | Barreira | Não aceita auth do cliente |
| `POST /sincronizar-ao-abrir` | Bloqueado sem auth | Barreira | Background/abertura |
| `POST /configuracao/testar-sefaz` | Não (padrão) | Prontidão local | DistDFe só com `forcarProbeDistDfe` + auth teste |
| `GET /buscar-chave` | Não (local) | — | Sem SOAP |
| `distribuicaoDFe.sincronizarDistribuicaoDFe` | Sim se auth | Dupla: avaliar + `exigirOperacaoRealVivaSeAplicavel` | Entrada interna |
| `distribuicaoDFe.consultarNotaPorChave` | Sim se auth | Idem | consChNFe |
| `CentralSyncBackgroundService` | Tentativa sem OPERACAO_REAL | Barreira fecha | Sem bypass |
| Manifestação 210210 | N/A | OPERACAO_REAL **não cobre** | Explicitamente rejeitado |

Montagem: `/api/central-entradas` com `verificarToken` + `exigirRecurso('fiscal')`.

---

## 4. Controles verificados

1. **Admin** — somente `ADMIN`/`SUPER_ADMIN` (ou `role=admin`) habilita/desabilita.  
2. **Confirmações no servidor** — `confirmacaoConsultaReal` + `confirmacaoAmbienteProducao` revalidados; UI sozinha não basta.  
3. **TTL 15 min** + token HMAC-like por empresa/seed/emitidoEm.  
4. **Empresa + CNPJ + tipo** — divergência bloqueia.  
5. **Desativação** — revoga seed; assert pré-SOAP impede transmissão.  
6. **Pré-voo** — empresa, A1 apto, produção, cooldown/NSU; `permitirFallbackGlobal: false`.  
7. **NSU/cooldown/137/656** — preservados no pipeline DistDFe/Gate/mutex (regressão P0.8 barreira).  
8. **Sem 210210 automático** no caminho OPERACAO_REAL.  
9. **Produção não auto-habilitada** ao fim desta sprint.

---

## 5. Arquivos alterados / criados

| Arquivo | Alteração |
|---|---|
| `backend/services/fiscal/autorizacaoTransmissaoSefaz.js` | Seed persistido, CNPJ, códigos REVOGADA/CNPJ_DIVERGENTE |
| `backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js` | `assertAutorizacaoViva`, revogação no desabilitar, CNPJ no emit |
| `backend/services/fiscal/distribuicaoDFe.js` | `exigirOperacaoRealVivaSeAplicavel` pré-SOAP |
| `backend/rotas/central-entradas.js` | Recusa injeção de token no body |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | Assert pré-sync + DI do serviço |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | Propaga `operacaoFiscalRealService` |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Propaga serviço à DistDFe |
| `tests/fiscal/microsprint-p0-9-auditoria-operacao-fiscal-real.test.js` | **Novo** — 15 testes |
| `tests/fiscal/microsprint-p0-8-ativacao-operacao-fiscal-real.test.js` | Ajuste CNPJ obrigatório |
| `docs/fiscal/microsprint-p0-9-auditoria-final-operacao-fiscal-real-relatorio.md` | Este relatório |

---

## 6. Testes executados (resultados reais)

Comandos (isolados, Temp, sem suíte ampla):

```bash
node --test tests/fiscal/microsprint-p0-9-auditoria-operacao-fiscal-real.test.js tests/fiscal/microsprint-p0-8-ativacao-operacao-fiscal-real.test.js
node --test tests/central-entradas/microsprint-p0-8-bloqueio-transmissoes-sefaz.test.js
```

| Suíte | Resultado |
|---|---|
| P0.9 auditoria (`microsprint-p0-9-...`) | **15/15 pass** |
| P0.8 ativação (`microsprint-p0-8-ativacao-...`) | **11/11 pass** |
| P0.8 barreira SOAP (`microsprint-p0-8-bloqueio-...`) | **13/13 pass** |

Evidências tipificadas (P0.9):

| Cenário | Esperado | Obtido | SOAP real? |
|---|---|---|---|
| Usuário comum habilita | `ADMIN_OBRIGATORIO` | OK | Não |
| Confirmação ambiente false | `CONFIRMACAO_CONSULTA_OBRIGATORIA` | OK | Não |
| Empresa/CNPJ divergente | bloqueio | OK | Não |
| Desativar com TTL restante | `OPERACAO_REAL_REVOGADA` + 0 SOAP | OK | Não |
| Certificado inválido | bloqueio pré-voo | OK | Não |
| Cooldown ativo | `COOLDOWN_ATIVO` | OK | Não |
| 210210 / expirada | bloqueio | OK | Não |
| OPERACAO_REAL viva + mock | mock local cStat 137 | OK | Não (mock) |
| Injeção token na rota | código rejeita | OK (assert estático) | Não |

Isolamento: `CDS_TEST_ISOLATION=1`, DB em `%TEMP%\cds-p09-audit-op-real-*` / `cds-p08-*`.

---

## 7. Riscos residuais e limitações

1. **SOAP em andamento:** se a desativação ocorrer após o envio TCP/TLS já iniciado, a resposta oficial pode chegar; NSU só avança conforme regra oficial. Iterações seguintes e novos envios são bloqueados.  
2. **Endpoint no pré-voo** pode ficar `ENDPOINT_PENDENTE`/`SKIP`; o envio SOAP oficial ainda exige resolução.  
3. **Consulta DistDFe** (após admin habilitar) pode ser disparada por qualquer usuário autenticado com recurso `fiscal` e confirmações — não só admin (habilitar continua admin-only).  
4. **tokenSeed** permanece no objeto de autorização em memória do processo durante o sync; não é devolvido na API de habilitar; assert pré-SOAP exige seed persistido coincidente.  
5. Esta auditoria **não** executou a primeira consulta real — isso fica para o operador autorizado após aprovação.

---

## 8. Critérios de aceite

| # | Critério | Status |
|---|---|---|
| 1 | Entradas de transmissão passam pela autorização central | Atendido |
| 2 | Autorização restrita a empresa e operação | Atendido (+ CNPJ) |
| 3 | Validade, desativação e permissões no backend | Atendido (F1 corrigida) |
| 4 | Associação certificado/CNPJ no momento da operação | Atendido (pré-voo + assert) |
| 5 | NSU/cooldown não contornáveis | Atendido (regressão barreira) |
| 6 | Regressões sem banco oficial | Atendido |
| 7 | Sem falhas críticas abertas | Atendido (F1 fechada) |

---

## 9. Decisão

**APROVADA COM RESSALVAS**

Ressalvas: tratamento de SOAP já em voo; endpoint soft no pré-voo; escopo de quem dispara consulta após ativação admin.

**Operação fiscal real permanece desabilitada.** A primeira consulta real deve ser iniciada explicitamente pelo operador autorizado (habilitar → confirmar → `Consultar DF-e (produção)`), em passo separado desta auditoria.
