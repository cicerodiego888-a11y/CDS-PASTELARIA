# MUV-CAP-01 — Relatório: serviço de capacidade e seleção pura

**Data:** 2026-10-26  
**Pré-requisitos:** AUD-MUV-01, AUD/SPEC-MUV-02  
**Homologação:** pendente (Tech Lead)

## 1. Objetivo cumprido

Serviço interno **somente leitura** que avalia, por empresa, se o carrinho pode ser atendido integralmente (estoque empresarial + ficha técnica), e função **pura** de seleção conforme a política matriz → filiais (`id ASC`). **Sem** integração ao PDV, sem escrita de estoque/venda/fiscal.

## 2. Arquivos

| Arquivo | Ação |
|---|---|
| `backend/motores/muv/capacidade/ServicoCapacidadeCarrinhoEmpresa.js` | Novo — `avaliarCapacidadeCarrinho`, `hashCarrinho` |
| `backend/motores/muv/capacidade/selecionarEmpresaCapacidade.js` | Novo — seleção pura + códigos de bloqueio |
| `backend/motores/muv/index.js` | Export lazy dos símbolos CAP-01 |
| `tests/muv/muv-cap-01-capacidade-selecao.test.js` | Novo — cenários 1–4, 7 + unitários da seleção |
| `docs/arquitetura/MUV-CAP-01-RELATORIO.md` | Este relatório |

**Não alterados:** `pdv.js`, `VendaApplicationService`, `VendaPagamentoService`, rotas `/api/vendas`, PDV Universal, bancos oficiais.

## 3. Comportamento

- Capacidade **por empresa**; proibido somar saldos entre CNPJs.
- Com ficha: `montarLinhasConsumo` + disponibilidade de insumos via `consultarDisponibilidade({ empresaId })`.
- Sem ficha: saldo do produto na empresa (ou sem restrição se `controla_estoque = 0`).
- Matriz: `escolherMatrizPadrao` / CNPJ `0001`; se `MATRIZ_AMBIGUA` → bloqueio (fail-closed P-01).
- Seleção: matriz capaz → `MATRIZ_ATENDE`; senão primeira filial capaz na ordem; senão `NENHUMA_EMPRESA_ATENDE` / `NENHUMA_EMPRESA_ELEGIVEL`.
- `meta.aviso = CONSULTA_NAO_RESERVA`; `hashCarrinho` para invalidação futura.
- `EMPRESA_SIMPLES` → `SELETOR_AUTOMATICO_NAO_APLICA` (P-09).
- `tipoSaldo` padrão `FISCAL` (P-06 opção a, parametrizável); `exigirFiscalValido` opcional (P-02).
- Comparação estrita com `roundStockQuantity` (P-08).

## 4. Testes executados

```text
node --test tests/muv/muv-cap-01-capacidade-selecao.test.js
→ 10 pass / 0 fail
```

| Caso | Resultado |
|---|---|
| Seleção pura matriz / filial / bloqueio | OK |
| Cenário 1 — matriz suficiente | seleciona matriz; estoque inalterado |
| Cenário 2 — matriz incapaz, filial capaz | seleciona filial B (`id` menor) |
| Cenário 3 — agregado ok, individual não | bloqueio `NENHUMA_EMPRESA_ATENDE` |
| Cenário 4 — ficha sem ingrediente | matriz incapaz; filial selecionada |
| Cenário 7 — sem elegíveis | `NENHUMA_EMPRESA_ELEGIVEL` + `SEM_ACESSO` |
| Hash / EMPRESA_SIMPLES | OK |

Fixtures: SQLite `:memory:` isolado.

## 5. Limitações conhecidas

- **Não** integrado ao `/pdv` nem a `POST /api/vendas` (próxima sprint PDV-SEL-01).
- Caixa aberto (P-05), copy UX (P-07) e override de UI (P-04) fora do escopo.
- Autorização de usuário: via `UsuarioEmpresaService` ou `listarEmpresasPermitidasIds` injetável; testes desligam ou forçam lista vazia.
- Capacidade é snapshot; concorrência real fica para revalidação/reserva na integração.
- Ordenação de filiais = `empresas.id ASC` (D-04); desempate por “maior estoque” (P-03) não implementado.

## 6. Encerramento

MUV-CAP-01 concluída. Aguardando homologação do Tech Lead. **Não** iniciar PDV-SEL-01 automaticamente.
