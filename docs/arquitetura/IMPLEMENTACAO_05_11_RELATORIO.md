# Relatório — Sprint 05.11

Interface administrativa para empresas e configuração fiscal individual. Sem novo motor fiscal, sem nova tabela, sem alteração do MUV ou do PDV Universal.

### Criado

- `frontend/erp/js/gestao-empresas-fiscal.js`
- `tests/erp/gestao-visual-multiempresa-05-11.test.js`
- docs 05.11

### Alterado

- `backend/rotas/fiscal.js` — upload aceita `empresa_id` e grava no storage oficial por empresa
- menu ERP + `app.js`
- atalho no Centro de Configurações

### Testes

`gestao-visual-multiempresa-05-11` — **23/23**. 04.01–04.14, 05.01–05.10, 04.07–04.09, MUC public contract, VendaApplication, Orquestrador, TEF, reservas PDV — **OK**.

### Limitações

- URLs SEFAZ e CSC já salvos não voltam no GET (DTO seguro 04.09); o operador informa de novo só para substituir.
- Upload por empresa exige recurso `fiscal` (`/api/fiscal`).
- UI não exercitada no browser nesta sessão.

### Próximo

Recursos de nicho permanecem fora do escopo desta sprint.
