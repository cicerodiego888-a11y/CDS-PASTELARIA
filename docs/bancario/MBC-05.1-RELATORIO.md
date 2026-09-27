# MBC-05.1 — Pendências de Conciliação + Valor Disponível

**STATUS:** CONCLUÍDO  
**Sprint:** MBC-05.1  
**Data:** 2026-09-07

## 1. Auditoria 757 → 746

### Causa raiz (exata)

No MBC-05 (fundação), o arquivo `tests/bancario/motor-bancario-05.test.js` foi **sobrescrito**.

| Item | Antes (HEAD / MBC-04) | Depois do overwrite MBC-05 |
|------|------------------------|----------------------------|
| Conteúdo | Sprint MBC-05 original: **provider MOCK + SecretStore** | Fundação conciliação financeira |
| `it()` | **30** | **19** |
| Delta | | **−11** |

**757 − 11 = 746** — casa exatamente com a suíte observada após o MBC-05.

### Classificação dos 11 testes

Não foram 11 arquivos perdidos. Foram **11 casos `it()`** do arquivo original `motor-bancario-05.test.js` (30 − 19 = 11), pertencentes ao sprint histórico **MBC-05 Provider/SecretStore** (ver também `docs/bancario/MBC-05-PROVIDER-SECRETS.md`).

| Classificação | Detalhe |
|---------------|---------|
| **teste deixou de ser descoberto / realmente perdido** | Os 30 testes MOCK/SecretStore pararam de executar porque o arquivo foi substituído |
| **não** removidos de propósito | Erro de nomenclatura/colisão de arquivo no sprint de fundação |
| **não** consolidados | A fundação criou 19 testes novos no mesmo path, em vez de arquivo dedicado |

### Correção neste sprint

1. **Restaurado** `tests/bancario/motor-bancario-05.test.js` a partir do `git HEAD` (30 testes MOCK/SecretStore).
2. Fundação movida para `tests/bancario/motor-bancario-05-fundacao.test.js`.
3. Novos testes em `tests/bancario/motor-bancario-05-1.test.js`.

Nenhum teste válido permanece perdido por descoberta.

**Nota:** o invariante “sem oauth na rota bancario.js” do MBC-05 MOCK foi atualizado para o provider MOCK (OAuth MP/OF existe em sprints posteriores e quebraria a restauração se mantido literalmente na API inteira).

## 2. Valor total / conciliado / disponível

| Campo | Regra |
|-------|--------|
| `valor_total` | `transacao_bancaria.valor` (imutável) |
| `valor_conciliado` | `SUM` de vínculos `ativo=1` e `status=conciliada` |
| `valor_disponivel` | `max(0, valor_total − valor_conciliado)` |

Se o cálculo bruto for negativo → `valor_disponivel = 0` + evento `CONCILIACAO_VALOR_INCONSISTENTE`.

## 3. Status derivado

Sem coluna nova na TX.

| Condição | `status_conciliacao` | Legado `status` |
|----------|----------------------|-----------------|
| conciliado = 0 | `nao_conciliada` | `pendente` |
| 0 < conciliado < total | `parcialmente_conciliada` | `pendente` |
| conciliado = total | `conciliada` | `conciliada` |

Constante: `STATUS_TRANSACAO_CONCILIACAO`.

## 4. Cancelamento

Soft (`ativo=0`): sai do SUM; disponível sobe; histórico preservado.

## 5. Pendências

- Service: `listarPendentes` enriquecido (`valor_total`, `valor_conciliado`, `valor_disponivel`, `status_conciliacao`, `provider`/`origem`, etc.).
- Rota dedicada: `GET /api/bancario/conciliacoes/pendentes` (sem duplicar lógica; equivalente a `?status=pendente` enriquecido).
- Filtros: conta, período, direção, provider (`external_source`), `status_conciliacao`.

## 6. UI

Seção **Conciliação pendente** + colunas Conciliado/Disponível/Status na grade.  
Modal com campo **Valor a conciliar** (máx. disponível; backend autoridade).  
Sem matching automático.

## 7. Concorrência

`BEGIN IMMEDIATE` + fila `withTx` + revalidação de disponível dentro da TX.  
Duas operações de R$ 100 com disponível R$ 100 → uma OK, uma bloqueada; soma ativa = 100.

## 8. Mercado Pago / Itaú mock

Tratados só como `TRANSACAO_BANCARIA` (`external_source`). Sem ramo específico na conciliação.

## 9. Testes / regressão

| Arquivo | Papel |
|---------|--------|
| `motor-bancario-05.test.js` | MOCK/SecretStore restaurado (30) |
| `motor-bancario-05-fundacao.test.js` | Fundação MBC-05 |
| `motor-bancario-05-1.test.js` | Pendências / parcial / concorrência |

Regressão: `node --test tests/bancario/motor-bancario-*.test.js`

| Marco | PASS | FAIL | SKIP |
|-------|------|------|------|
| Baseline MBC-04 | **757** | 0 | 0 |
| Após overwrite MBC-05 (erro) | **746** | 0 | 0 |
| Após MBC-05.1 (restauração + fundação dedicada + novos) | **789** | 0 | 0 |

Conta do delta 746 → 789: −19 (arquivo fundação removido do path `05`) +30 (MOCK restaurado) +19 (arquivo `05-fundacao`) +13 (`05-1`) = **+43** → 789.

## 10. Decisões

- Não criar tabela nova.
- Status parcial derivado.
- Colisão de nome `motor-bancario-05` corrigida sem duplicar testes artificialmente.

## 11. Limitações

- Sem matching automático / IA / score.
- Matching legado ainda exige valor candidato = valor total da TX.

## 12. Próximo sprint

**MBC-05.2 / matching parcial** — sugestões respeitando `valor_disponivel` em TX parcialmente conciliada.
