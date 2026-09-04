# Consumo de ficha técnica na venda — Operação Pastelaria (Sprint 03.04)

## 1. Objetivo

Venda de produto comercial com ficha ativa consome insumos no `estoque_empresa` da **empresa da venda** (`vendas.empresa_id`). Sem novo motor de venda. PDV Universal congelado.

## 2. Estrutura encontrada

| Peça | Classe | Uso |
|------|--------|------|
| `ficha_tecnica` / itens (03.03) | A | Fonte compartilhada |
| `debitarEstoqueItemVenda` | A núcleo | Writer oficial de baixa |
| `estoqueSaldosPublico` | A/B | Porta F×NF + dual-write `estoque_empresa` |
| MUC `MotorConversao` | A | Embalagem de compra — **não** ML↔L |
| `MotorUnidadesMedida` | B adaptar | Catálogo de unidades + fatores SI (ML/L, G/KG) |
| Movimentação com `venda_id` | E | Não havia rastreio de consumo de ficha |

## 3. Writer de estoque

Caminho oficial: `VendaPagamentoService` → `reduzirEstoqueDistribuido` (produto vendido) → **`consumirFichaTecnicaDaVenda`** → `debitarEstoqueItemVenda` (insumos) com `exigirEmpresa: true` e `empresaId = venda.empresa_id`.

Não há segundo writer paralelo. MUV não entra no POST.

## 4. Ficha técnica

Compartilhada (`produto_id`). Sem `empresa_id`. Só cabeçalho **ativo** gera consumo.

## 5. Componentes

Somente `INSUMO` ativo, quantidade > 0. Comercial como componente: bloqueio. Insumo inativo: bloqueio sem baixa parcial.

## 6. Cálculo

```
quantidade_estoque = converter(quantidade_vendida × quantidade_ficha, unidade_ficha → unidade_cadastro_insumo)
```

Sem rendimento de produção.

## 7. Unidades

Catálogo `MotorUnidadesMedida` (`UNIDADES_COMERCIAIS`). Unidade desconhecida: rejeitada na ficha (03.03) e na conversão.

## 8. Conversões

`MotorUM.converterQuantidadeEntreUnidades` — fatores SI da mesma família (ML↔L, G↔KG, CM↔M). Famílias distintas: `CONVERSAO_INVALIDA` antes da baixa. Não duplica o pipeline MUC de embalagem.

## 9. Empresa

`consumirFichaTecnicaDaVenda({ vendaId, empresaId, itens, db })` — `empresaId` é o persistido da venda (`exigirEmpresaDaOperacao`). Sem `req`. Sem `|| 1`, primeira empresa, `empresa_operacional_id`, COMPAT.

## 10. Estoque

Leitura de disponibilidade: `consultarSaldo` com `empresaId` (`estoque_empresa`). Baixa: porta oficial. Agregação por insumo antes de qualquer débito.

## 11. Transação

Chamada **dentro** de `BEGIN IMMEDIATE` de `criarVenda`, após baixa dos itens vendáveis e **antes** de COMMIT. Erro de domínio: `ROLLBACK`.

## 12. Atomicidade

Valida todas as fichas, converte, soma por insumo, verifica saldos; só então debita. Falha em um componente: nenhum consumo persistido (na transação da venda, também reverte baixa do produto).

## 13. Estoque insuficiente

`SALDO_INSUFICIENTE` com nome do insumo. Sem saldo negativo via pré-checagem em `estoque_empresa`.

## 14. Produto sem ficha

`consumido: false`. Venda segue.

## 15. Ficha inativa

Não consome. Venda segue.

## 16. Cross-company

Mesma ficha; estoque A ≠ B. Venda A não toca B.

## 17. Cancelamento

**Pendência.** O núcleo devolve estoque do **item vendido** (`creditoEstoqueVendaViaPorta` / `vendas.empresa_id`). **Não** estorna insumos da ficha nesta sprint. Tabela `venda_ficha_consumo` existe para sprint de estorno.

## 18. Devolução

Mesma pendência: devolver o comercial não devolve automaticamente os insumos da ficha.

## 19. Financeiro

Sem lançamento extra.

## 20. Caixa

Sem recebimento extra.

## 21. Fiscal

Uma venda. Consumo é estoque.

## 22. MUV

Fora do POST. Sem `criarAtendimento`.

## 23. PDV Universal

Congelado. Sem lógica de ficha no JS do PDV.

## 24. Testes

`tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js` T01–T35.

## 25. Riscos

1. Writer de saldo ainda valida piso em `produtos` (global) e espelha `estoque_empresa`; a pré-checagem empresarial evita negativo isolado.  
2. Cancelamento/devolução não revertem ficha.  
3. Componente comercial na ficha (se dados inconsistentes) bloqueia consumo.  
4. Dual-write continua atualizando `produtos` além de `estoque_empresa`.
