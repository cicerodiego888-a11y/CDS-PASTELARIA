# Microsprint P0.11 — Normalização do cooldown e consulta controlada

**Prioridade:** P0 — URGENTE  
**Data:** 18/10/2026  
**Dependências:** P0.9, P0.10-A, P0.10-B  
**Veredito:** **APROVADO COM RESSALVAS**

---

## 1. Causa identificada do bloqueio (P0.10-B + auditoria A)

| Fato | Evidência |
|---|---|
| Sync automática ligada e ciclando | `sync_automatica_habilitada=true` |
| Três empresas em cooldown pós-656 | `cooldown_ate` futuro + `ultimo_cstat=656` |
| Dualidade de mecanismos | NSU: 1h fixo em `central_entradas_nsu`; Gate: progressivo 10→120 min |
| Bypass / fail-open | `forcar`/`ignorarCooldown` ignoravam NSU; falhas do Gate engolidas com `catch {}`; cooldown indisponível seguia |
| `recuperacao_xml_ativa=true` no KV | Legado: motor **não** autoriza ciclo SOAP (`ativa` forçado `false`) |

O bloqueio operacional atual das três empresas era **cooldown legítimo pós-656**, não flag desligada.

---

## 2. Arquivos modificados / criados

| Arquivo | Papel |
|---|---|
| `backend/motores/central-entradas/services/CentralConsultaDistDfeDecisaoService.js` | **Novo** — decisão unificada pré-DistDFe |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Usa decisão; Gate fail-closed; rate limit |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | Gate fail-closed; `forcar`/`ignorarCooldown` não liberam DistDFe |
| `backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js` | Pré-voo via decisão (NSU + Gate) |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | Respeita cooldown NSU antes de consChNFe |
| `tests/.../microsprint-p0-11-normalizacao-cooldown-consulta-controlada.test.js` | **Novo** — suíte P0.11 |
| `tests/.../microsprint-correcao-segura-cursor-656.test.js` | Guardião + mutex alinhados |
| `tests/.../microsprint-auditoria-cooldown-distdfe.test.js` | Expectativas de mensagem/código |

---

## 3. Regras de cooldown antes e depois

| Aspecto | Antes | Depois |
|---|---|---|
| Fonte NSU | `avaliarCooldown` (1h / FILA_ESGOTADA) | Mantida — regra fiscal **não** alterada |
| Fonte Gate | Progressivo 10/20/40/60/120 min | Mantida |
| Decisão | Checagens dispersas; falhas fail-open | `CentralConsultaDistDfeDecisaoService` — bloqueia se **qualquer** fonte estiver ativa |
| `forcar` / `ignorarCooldown` | Podiam pular NSU | **Não** liberam DistDFe |
| Relógio | `Date` ISO UTC + display Fortaleza | Inalterado |
| Intervalo 656 NSU | 60 min | 60 min (sem redução) |

Códigos da decisão: `COOLDOWN_ATIVO`, `AUTORIZACAO_AUSENTE`, `EMPRESA_INVALIDA`, `CONSULTA_EM_ANDAMENTO`, `RATE_LIMIT_ATIVO`, `PRONTO_PARA_CONSULTA` (+ `GATE_INDISPONIVEL`, `NSU_INDISPONIVEL`).

Compat de API sync: `codigo` legado `AGUARDAR_JANELA_DFE` + `codigoDecisao: COOLDOWN_ATIVO` + `motivoIgnorado` (`FILA_ESGOTADA` / `COOLDOWN_EXPLICITO`).

---

## 4. Comportamento por origem

| Origem | Cooldown/Gate | Auth na decisão | SOAP |
|---|---|---|---|
| `CONSULTA_DFE_REAL` | Sempre | Exigida | Só com OPERACAO_REAL emitida |
| `BACKGROUND` / `MANUAL` / `ABRIR_CENTRAL` | Sempre | Não na decisão (barreira SOAP permanece) | Sem auth → não transmite |
| Pré-voo / status | Diagnóstico (sem SOAP) | Não | Nunca |
| Recuperação XML | Gate + cooldown NSU | N/A (legado não autoriza ciclo) | Bloqueada se cooldown/Gate |

**Opção B (BACKGROUND autorizado) não foi implementada.**

---

## 5. Tratamento do cStat 656

Preservado (testado):

- Não avança `ult_nsu` / `max_nsu`
- Não usa NSU de resposta de erro
- Aplica `cooldown_ate` (+1h NSU) e Gate progressivo
- Novas consultas bloqueadas enquanto vigente
- Não há retry automático pós-656
- 656 ≠ 137/138

---

## 6. Coordenação com recuperação de XML

- KV `recuperacao_xml_ativa=true` continua **legado**: `lerConfigDeMapa` força `ativa=false` e `autorizaTransmissaoSefaz=false` (sem desligar o flag no banco).
- Antes de consChNFe, o motor agora consulta `avaliarCooldown` do CNPJ/ambiente — fail-closed se indisponível.
- Mutex DistDFe/consChNFe compartilhado (`SefazTransmissaoMutex`) permanece.
- Correção arquitetural maior (auth operacional do motor XML) **fora do escopo** — documentada.

---

## 7. Observabilidade do Gate (SyncExecucao)

- `catch { /* ignore */ }` removido no pré-sync do Gate.
- Falha → log `gate_falha_pre_sync_fail_closed` + retorno `GATE_INDISPONIVEL` (fail-closed, sem SOAP).
- Cooldown NSU indisponível → fail-closed (`NSU_INDISPONIVEL`).
- Eventos/logs com `empresaId` quando disponível.
- Falha de sync de uma empresa não derruba o processo Node.

---

## 8. Testes

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/microsprint-p0-11-normalizacao-cooldown-consulta-controlada.test.js \
  tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js \
  tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js
```

**Resultado:** 41/41 aprovados. Sem SEFAZ real. Sem banco oficial.

Cobertura: cooldown vigente/vencido, auth ausente, 656 preserva NSU, mutex, isolamento multiempresa, recuperação XML legado, Gate fail-closed, rate limit anti-rajada, consultar-dfe não ignora cooldown, guardião SQLite.

---

## 9. Confirmações de segurança desta sprint

- Nenhuma consulta SOAP/SEFAZ real.
- Nenhuma alteração no banco oficial (`ProgramData`).
- Nenhuma flag/NSU/cooldown de produção alterada.
- Nenhuma sincronização operacional executada.
- Sem commit/push/merge.
- Sem `CDS_ALLOW_OFFICIAL_DB=1`.

---

## 10. Procedimento para futura consulta controlada (autorização separada)

1. Conferir status por empresa: `GET /api/central-entradas/operacao-fiscal-real/status` (com `empresaId`).
2. Confirmar `preVoo.ok` / `nsu.cooldownAtivo === false` e `proximaConsultaEm` no passado.
3. Garantir OPERACAO_REAL habilitada para aquela empresa.
4. Chamar **uma empresa por vez**:  
   `POST /api/central-entradas/operacao-fiscal-real/consultar-dfe`  
   com `confirmacaoConsultaReal=true` e `confirmacaoAmbienteProducao=true`.
5. Aguardar ≥30s (rate limit local) e liberação de mutex antes da próxima empresa.
6. Em cStat 656: **não** repetir; aguardar cooldown; NSU permanece.

Esta sprint **não** autoriza a primeira consulta operacional.

---

## 11. Riscos remanescentes

| Risco | Mitigação / ressalva |
|---|---|
| BACKGROUND ainda agenda ciclos | Sem auth DistDFe não transmite; Opção B pendente |
| Dualidade NSU 1h vs Gate progressivo | Decisão usa o mais restritivo; intervalos não unificados numericamente |
| Rate limit só em memória do processo | Reinício zera o mapa; cooldown persistido no NSU/Gate continua |
| Motor XML legado | Flag true no KV não liga SOAP; auth operacional futura necessária |
| Auditoria sem `empresa_id` em alguns registros | Observabilidade parcial (pré-existente) |

---

## 12. Critérios de aceitação

- [x] Causa do bloqueio documentada  
- [x] Decisão de cooldown consistente  
- [x] Cooldown vigente respeitado  
- [x] Autorização e Gate preservados  
- [x] NSU preservado no 656  
- [x] Concorrência controlada (mutex + rate limit)  
- [x] Falhas do Gate observáveis e fail-closed  
- [x] Testes direcionados isolados aprovados  
- [x] Teste do guardião corrigido sem enfraquecimento  
- [x] Nenhuma consulta real SEFAZ  
- [x] Nenhuma alteração no banco oficial  
- [x] Relatório concluído  

---

## 13. Veredito

### **APROVADO COM RESSALVAS**

Ressalvas: Opção B não implementada (conforme escopo); intervalos NSU/Gate permanecem semanticamente distintos (decisão composta); rate limit local volátil; motor XML ainda sem autorização operacional de ciclo.

Aguardar autorização específica para a primeira consulta operacional controlada (uma empresa por vez, pós-cooldown verificado).
