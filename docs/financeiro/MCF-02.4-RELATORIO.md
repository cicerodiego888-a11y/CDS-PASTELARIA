# MCF-02.4 — Relatório do ensaio controlado

**Status:** ensaio em cópia isolada concluído nos testes  
**Backfill operacional / dados reais:** **NÃO AUTORIZADO** — aguardar nova aprovação expressa do Tech Lead

---

## 1. Origem isolada (evidência)

| Item | Valor |
|------|--------|
| `ambiente_id` | `MCF-02.4-ENSAIO-CONTROLADO` |
| Diretório | `tests/fixtures/mcf-02.4-ensaio/` |
| Banco | `ensaio-contas-pagar.sqlite` |
| Backup | `ensaio-contas-pagar.backup.sqlite` |
| Metadados | `AMBIENTE.json`, `EVIDENCIA-ENSAIO.json` (gerados pelo teste) |

O executor **recusa** escrita se:
- `permitirEscritaIsolada !== true`
- `ambienteId` sem prefixo `MCF-02.4-ENSAIO-`
- caminho parecer operacional/cliente (`mercadao.db`, `producao`, etc.)

---

## 2. Artefatos implementados

| Arquivo | Papel |
|---------|--------|
| `backend/motores/mcf/schema/mcfMigracaoHistoricaSchema.js` | Lotes, idempotência, auditoria, meta do ensaio |
| `backend/motores/mcf/services/ContasPagarMigracaoHistoricaExecutor.js` | Preparar lote + executar/retomar |
| `tests/financeiro/mcf-02.4-ensaio-migracao.test.js` | Ensaio automatizado |
| Este relatório | Evidências e riscos |

---

## 3. Pré-validação

- Dry-run duplo com fingerprint estável
- Simulação com batimento de quantidades
- Itens `revisao_manual` **excluídos** do processamento automático (`pulado`)
- Sem aprovação automática de ambiguidades
- Sem inventar pagamentos a partir de status legado

---

## 4. Ações do ensaio

| Ação | Comportamento |
|------|----------------|
| `vincular` | Compat 1:1 + marca legado como projeção; **preserva** `valor_restante` e pagamentos MCF |
| `criar_titulo` | Título `aberto` com restante = original; religa legado como projeção; **0** pagamentos sintéticos |
| `ignorar` | Só auditoria / status ok no lote |
| `revisao_manual` | Não processado |

**Interrupção:** `interromperAposN` → status `interrupido`  
**Retomada:** reprocessa apenas `pendente`  
**Replay:** 0 itens processados; sem duplicidade de vínculos/títulos

**Abort:** se item pendente some do dry-run (origem mudou) → lote `abortado`

---

## 5. Verificação antes/depois

Comprovada nos testes:

- `pagamentos_qtd` e `pagamentos_valor` MCF **inalterados**
- Vínculos compat aumentam conforme vincular/criar
- Dry-run pós: `vincular=0` e `criar_titulo=0`
- Auditoria com ações de vincular/criar/ignorar/interrupção
- Comparação `compararSnapshots` aprovada (sem mudança inexplicada em pagamentos)

---

## 6. Testes executados

```bash
node --test tests/financeiro/mcf-02.4-ensaio-migracao.test.js
```

Regressão sugerida: suites MCF-02.1 … 02.3.

**Não validado:** Electron real; matching MBC (intocado); qualquer base de cliente.

---

## 7. Riscos residuais

- Casos `revisao_manual` / `pago`/`parcial` sem evidência continuam fora do lote automático
- Fingerprint global muda após migração parcial (esperado); a segurança está na revalidação por item e no abort se o pendente sumir
- Remoção da projeção **sintética** gerada no `criar` (não é histórico de cliente) — histórico legado é preservado e religado

---

## 8. Próximo passo (bloqueado)

Qualquer backfill operacional exige **nova aprovação expressa** do Tech Lead. Este ensaio **não** autoriza migração em dados reais.
