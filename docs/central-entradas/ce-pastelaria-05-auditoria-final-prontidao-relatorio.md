# CE-PASTELARIA-05 — Auditoria final de prontidão e recuperação da NF-e 4456

**Tipo:** auditoria + correções mínimas comprovadas + testes isolados  
**Data:** 18–19/10/2026  
**Referência:** CE-PASTELARIA-03 · CE-PASTELARIA-04  
**Veredito:** **APROVADO COM RESSALVAS**

> Prontidão técnica para consulta DistDFe controlada **não** prova que a SEFAZ entregará a NF-e 4456.

---

## 1. Proteções respeitadas

- [x] Sem DistDFe / consChNFe / 210210 / SOAP  
- [x] Sem abrir/alterar banco oficial  
- [x] Sem mutar NSU, cooldown, flags, certificados, OPERACAO_REAL em produção  
- [x] Sem liberar FILA em produção  
- [x] Sem desativar rotinas automáticas como “solução”  
- [x] Sem commit / push / merge / reset  
- [x] Sem restaurar `/sincronizar` como caminho real  

---

## 2. Revisão CE-04 (código real)

| # | Item | Arquivo / função | Evidência |
|---|---|---|---|
| 1 | Auth por empresa | `CentralConsultaDistDfeDecisaoService.avaliar` | `auth.empresaId` ≠ `empresaId` → `AUTORIZACAO_AUSENTE` |
| 2 | empresaId/CNPJ/ambiente explícitos | idem | `EMPRESA_INVALIDA` / `CONTEXTO_INVALIDO` se ausentes |
| 3 | BACKGROUND / abrir / manual sem auth | `CentralSincronizacaoService._sincronizarEmpresa` + decisão | `verificarAutorizacao: true`, `permitirSemAutorizacao: false`; BACKGROUND em `origemExigeAuth` |
| 4 | `forcar` / `ignorarCooldown` | `CentralSyncExecucaoService` / sync | Comentários e fluxo: não liberam DistDFe |
| 5 | Cooldown / FILA | `CentralNsuService.avaliarCooldown` + decisão | Bloqueios `COOLDOWN_ATIVO` / `FILA_ESGOTADA` antes do SOAP |
| 6 | Locks | `SefazTransmissaoMutex` + `comLockDistDfe` | Aquisição/liberação em finally; `CONSULTA_EM_ANDAMENTO` |
| 7 | Erros → bloqueio | decisão NSU/Gate catch | `NSU_INDISPONIVEL` / `GATE_INDISPONIVEL` |
| 8 | Liberação FILA só local | `liberarFilaEsgotadaAutorizada` | `consultaExecutada: false`, sem SOAP |
| 9 | Evento obrigatório | `emitirEventoObrigatorio` + NSU liberar | Tipo `FILA_ESGOTADA_LIBERACAO_OP` antes do sucesso |
| 10 | Falha evento reverte | `CentralNsuService.liberarFilaEsgotadaAutorizada` | Rollback `ultimoCstat`; `EVENTO_LIBERACAO_FALHOU` |
| 11 | Idempotência correlação | `buscarPorTipoECorrelationId` | Mesma correlação → sem segundo evento |
| 12 | Consulta válida possível | decisão com auth + cursor livre | `PRONTO_PARA_CONSULTA` (teste CE-05 #18) |

---

## 3. Manifestação 210210 e MIRX

| Caminho | Pode SOAP? | Auth | Empresa | Barreiras | Conclusão |
|---|---|---|---|---|---|
| Scheduler 210210 | Tentaria via `enviarManifestacao` | Runtime exige auth; **OPERACAO_REAL não cobre 210210** | Contexto do documento | Gate + claim + prazo | **Fail-closed sem auth explícita** (TESTE_ISOLADO só em testes) |
| Botão/manual ciência | Idem | Idem + `confirmado` | Idem | Idem | Sem auth → não transmite |
| MIRX | DistDFe/consChNFe via ciclo | Runtime DistDFe exige auth; histórico bloqueado | Por documento/empresa | Ciência aceita + Gate + `forcarConsulta:false` | Sem bypass DistDFe comprovado |
| Motor recuperação XML | Config `autorizaTransmissaoSefaz: false` | Legado não autoriza ciclo SOAP | — | Cooldown/Gate | Não transmite com config padrão |

**Bypass DistDFe-equivalente em 210210/MIRX:** não comprovado.  
**Ressalva:** scheduler de manifestação ainda *agenda* ciclos; a barreira SOAP impede transmissão sem token. Não há modo produção separado de 210210 nesta auditoria (fora do escopo DistDFe). Não foi necessário alterar regras fiscais de negócio.

---

## 4. Probe diagnóstico (`forcarProbeDistDfe`)

| Pergunta | Achado |
|---|---|
| Pode chegar ao SOAP? | Só se `forcarProbeDistDfe === true` **e** auth + Gate + decisão + lock OK |
| Rota operacional? | `POST …/testar-sefaz` → `testarSefazDiagnostico` **remove** `forcarProbeDistDfe` → só prontidão local |
| Auth na decisão? | **Corrigido nesta sprint:** `verificarAutorizacao: true`, origem `DIAGNOSTICO_PROBE` em `origemExigeAuth` |
| Cooldown/FILA? | Sim (`verificarCooldownNsu: true`) |
| Nome “diagnóstico” mascara real? | Mitigado: rota HTTP não ativa probe; flag só por injeção de teste |

---

## 5. Matriz de prontidão multiempresa (testes)

| Caso | Emp.1 | Emp.2 | Emp.3 | Resultado |
|---|---|---|---|---|
| Auth cruzada | auth→3 | — | bloqueio | PASS |
| CNPJ auth divergente | — | — | bloqueio | PASS |
| Ambiente inválido | — | — | `CONTEXTO_INVALIDO` | PASS |
| Certificado/593 | — | — | bloqueio | PASS |
| Cooldown | bloqueia | bloqueia | bloqueia | PASS |
| FILA | — | — | bloqueia | PASS |
| Lock/concorrência | — | — | bloqueia | PASS |
| NSU isolado | cooldown | — | pronto | PASS |
| Persistência por empresaId | chave emp1 ≠ emp3 | — | OK | PASS |
| 656 sem retry / 137 sem doc | — | — | OK | PASS |
| Evento liberação fail-closed | — | — | OK | PASS |
| Probe sem bypass | — | — | OK | PASS |

---

## 6. Testes executados

Comando (cada suíte, sequencial):

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test <arquivo>
```

| Suíte | Pass | Fail |
|---|---|---|
| `ce-pastelaria-05-auditoria-final-prontidao.test.js` | **19** | 0 |
| `ce-pastelaria-04-…` | 17 | 0 |
| `ce-pastelaria-03-…` | 12 | 0 |
| `sprint-ce-pastelaria-02-…` | 9 | 0 |
| `sprint-final-ce-encerramento-01` | 18 | 0 |
| `microsprint-p0-11-…` | 15 | 0 |
| `microsprint-p0-14-…` | 14 | 0 |
| **Total** | **104** | **0** |

- SOAP: **não executado**  
- Banco oficial: **não acessado/alterado**  
- Ruído: alguns testes de regressão ainda carregam `database.js` no grafo de requires sob isolamento temp (não produção). Execução **sequencial** evitou `SQLITE_BUSY` de corrida.

---

## 7. Arquivos alterados nesta sprint

| Arquivo | Justificativa |
|---|---|
| `CentralConsultaDistDfeDecisaoService.js` | Incluir `DIAGNOSTICO_PROBE` / `diagnostico` em `origemExigeAuth` |
| `CentralDiagnosticoService.js` | Probe exige auth na decisão (`verificarAutorizacao: true`) |
| `CentralEntradasOrchestrator.js` | Rotas operacionais removem `forcarProbeDistDfe` |
| `procedures/preparacaoRecuperacaoNfe4456.js` | Checklist completo: chave, certificado, decisão, lock, confirmação humana; avisos sobre FILA local |
| `ce-pastelaria-05-….test.js` | **Novo** — matriz prontidão + probe + manif/MIRX estático |
| `ce-pastelaria-04-….test.js` | Ajuste campos novos do procedimento |

---

## 8. Pendências e riscos residuais

1. Estado real da emp.3 (cooldown/FILA/NSU) **não** foi relido nesta sprint — operação futura exige pré-voo ao vivo autorizado.  
2. Manifestação 210210 automática permanece fail-closed por barreira SOAP; não há autorização de produção dedicada (por desenho P0.8).  
3. MIRX/recuperação XML dependem de auth DistDFe na barreira — sem auth não transmitem; não substituem DistDFe da 4456.  
4. Prontidão ≠ garantia de entrega da chave pela SEFAZ.  
5. Eventual `consChNFe` exige autorização **separada**.

---

## 9. Procedimento NF-e 4456

Módulo: `backend/motores/central-entradas/procedures/preparacaoRecuperacaoNfe4456.js`

- **Não transmite**, **não libera FILA**, **não altera produção**.  
- Checklist exige: emp.3 + CNPJ `38204469000204` + chave + certificado + cooldown off + FILA off + decisão favorável + lock livre + pré-voo + OPERACAO_REAL + confirmação humana específica.  
- Aviso explícito: liberação local da FILA **não** recupera XML e **não** autoriza DistDFe.  
- Pós-DistDFe (futuro): máx. 1 tentativa; parar em 656/137/erro; sem retry; chave ausente → encerrar; `consChNFe` só com auth separada; se receber → comprovar `empresa_id=3`.

**Recuperação real não executada nesta sprint.**

---

## 10. Confirmações finais

| Item | Status |
|---|---|
| Transmissão real SEFAZ | **Não executada** |
| Banco oficial | **Não alterado** |
| Central preparada para DistDFe controlada (código+testes) | **Sim, com ressalvas** |
| Prova de existência da 4456 na SEFAZ | **Não afirmada** |
| Próxima operação real | **Somente após revisão + autorização explícita** |

Não iniciar nova sprint nem tentativa SEFAZ automaticamente.
