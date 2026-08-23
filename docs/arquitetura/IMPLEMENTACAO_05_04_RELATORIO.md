# Relatório — Sprint 05.04

## Carrinho universal

### Arquivos criados

- `backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js`
- `frontend/pdv-universal/pdv-universal-cart.js`
- `tests/pdv-universal/carrinho-universal-05-04.test.js`
- `docs/arquitetura/IMPLEMENTACAO_05_04_CARRINHO_UNIVERSAL.md`
- `docs/arquitetura/IMPLEMENTACAO_05_04_RELATORIO.md`

### Arquivos alterados

- `backend/motores/pdv-universal/PDVUniversalApplicationService.js`
- `backend/rotas/pdv-universal.js`
- `frontend/pdv-universal/index.html`
- `frontend/pdv-universal/pdv-universal.js`
- `frontend/pdv-universal/pdv-universal.css`
- roadmap V1

### Não alterados

PDV legado, `POST /api/vendas`, VendaPagamento, TEF, MUV persistente, reservas, NFC-e.

### Decisões

Empresa do item nunca vem do produto. Identificação automática só com exatamente uma empresa com saldo. Carrinho sem tabela.

### Testes

`carrinho-universal-05-04` — **25/25**. 05.01–05.03 e 04.01–04.14 + venda/TEF/estoque: **OK**.

### Limitações

Sem checkout. Sem reserva. Sem scanner dedicado além do campo de busca. Sem teste manual no browser nesta sessão.

### Próxima sprint (não iniciada)

**05.05** — checkout EMPRESA_UNICA reusando `VendaApplicationService`.
