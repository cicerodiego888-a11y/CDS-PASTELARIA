# Relatório — Sprint 05.12

Acesso visual oficial ao PDV Universal existente. Sem novo PDV e sem novo motor.

### Causa

Menu e dashboard abriam só `/pdv`.

### Alterado

- `frontend/erp/index.html` — PDV Universal + PDV legado
- `frontend/erp/js/dashboard-command.js`
- `frontend/pdv/index.html` — atalho no legado
- `frontend/shared/js/core.js` — visibilidade dos itens
- `frontend/shared/js/pdv-acesso-oficial.js` (novo)
- identificação visual mínima no `index.html` / CSS do Universal

### Não alterado

Login/caixa/Electron inicial, `POST /api/vendas`, MUV, VendaApplicationService.

### Testes

`ativacao-visual-acesso-05-12` — **19/19**. 05.01–05.11, MUC, VendaApplication, Orquestrador, TEF — **OK**.

### Validação visual

Tentei abrir `http://127.0.0.1:3001` nesta sessão: servidor HTTP **não estava no ar** e não há ferramenta de browser/Electron disponível no agente.

**VALIDAÇÃO VISUAL MANUAL NÃO EXECUTADA POR AUSÊNCIA DE AMBIENTE NAVEGÁVEL.**

Para validar no seu ambiente: login → ERP → Comercial → **PDV Universal** (sem digitar URL). O legado permanece em **PDV legado**.
