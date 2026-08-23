# Relatório — Sprint 05.02

## Contexto operacional e seleção de empresa

### Arquivos criados

- `backend/services/pdv-universal/PDVUniversalContextService.js`
- `tests/pdv-universal/contexto-operacional-05-02.test.js`
- `docs/arquitetura/IMPLEMENTACAO_05_02_CONTEXTO_OPERACIONAL_EMPRESA.md`
- `docs/arquitetura/IMPLEMENTACAO_05_02_RELATORIO.md`

### Arquivos alterados

- `backend/motores/pdv-universal/contratos.js` (capabilities 05.02)
- `backend/motores/pdv-universal/PDVUniversalApplicationService.js` (delega ao ContextService)
- `backend/rotas/pdv-universal.js` (`PUT /contexto/empresa`)
- `tests/pdv-universal/fundacao-pdv-universal-05-01.test.js` (GET + PUT coexistentes)
- `docs/arquitetura/ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md`

### Não alterados

`VendaApplicationService`, MUV de negócio, TEF, estoque, `POST /api/vendas`, PDV legado.

### Contrato

GET retorna modo, operador, empresa selecionada, disponíveis (só ativas), capabilities, `exige_selecao`, `pronto_para_checkout`.  
PUT valida empresa e devolve contexto. Sem escrita no domínio.

### Testes

`contexto-operacional-05-02` — **25/25**. Fundação 05.01 — **15/15**.  
Regressão 04.01–05.02, VendaApplication, Orquestrador e TEF: **OK**.

### Próxima sprint (não iniciada)

**05.03** — nova tela principal do PDV Universal, consumindo apenas `GET /api/pdv-universal/contexto`.
