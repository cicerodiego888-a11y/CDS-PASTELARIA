# PDV-MOBILE-06 — Interface única e homologação integrada

## 1. Diagnóstico anterior à alteração

- `/mobile-pedido/` e `/mobile-pdv/` são páginas da mesma origem, servidas por `backend/server.js`. A autenticação é o JWT em `localStorage` (`token` e `user`). Sem token, a página vai para `/login`.
- A empresa ativa fica em `CdsEmpresaContexto` (`cds_empresa_id` e `cds_empresa`). O operador exibido sai do usuário da sessão, não de um campo livre.
- O pedido em andamento vivia só na memória da página. O carrinho avulso e as parcelas do PDV também. O handoff do pedido para o PDV já ficava em `sessionStorage` (`pdvPedidoHandoff`). Cada abertura do PDV chamava `PagamentoSequencial.reset()`, o que apagava pagamento pendente.
- O banco do CDS é SQLite. Não há PostgreSQL nem `DATABASE_URL`. A licença é a linha da tabela `licenca`. Sem `codigo_licenca`, `verificarLicenca` responde `LICENCA_AUSENTE` e `licencaMiddleware` bloqueia a API com “Sistema não ativado.” A proteção não foi alterada.
- O processo `npm start` da porta 3001 usa o banco padrão. Esse caminho é o oficial (`ProgramData\MercantilFiscal\dados\mercadao.db`). Ele não foi aberto. Não existe outro banco com licença válida que se possa afirmar ser só de testes.

Classificação do diagnóstico: CONCLUÍDO.

## 2. Arquivos

Criados:

- `frontend/mobile/index.html`
- `frontend/mobile/mobile-inicio.js`
- `frontend/shared/js/cds-mobile-operacao.js`
- `tests/mobile-pdv/pdv-mobile-06.test.js`
- este relatório

Alterados:

- `backend/server.js` — rota `/mobile/`
- `frontend/mobile-pedido/index.html` e `frontend/mobile-pdv/index.html` — link Início
- `frontend/mobile-pedido/mobile-pedido.js` e `frontend/mobile-pdv/mobile-pdv.js` — retomada do estado da aba
- `frontend/mobile-pedido/mobile-pedido.css` — botões da entrada e correção de uma chave CSS excedente
- `frontend/pdv/js/pagamentoSequencial.js` — `reidratar`, só para recolocar parcelas já existentes
- `frontend/shared/js/pdv-acesso-oficial.js` — `/mobile/` entra nos destinos de login

Nenhuma rota antiga foi removida. O fluxo de fechamento, os motores comerciais e a licença não foram reescritos.

## 3. Arquitetura e navegação

A entrada é `/mobile/`. A tela mostra a marca CDS Sistemas, o operador, a empresa, o estado da sessão, o aviso da licença e dois botões: PEDIDO e PDV. Eles abrem as páginas que já existiam.

Pedido e PDV têm o link Início para `/mobile/`. Alternar não pede outro login. Voltar ao início não grava venda, não cancela pedido e não apaga o estado da aba.

`/mobile-pedido/` e `/mobile-pdv/` continuam abrindo o módulo pedido. Não há redirecionamento automático dessas rotas para a entrada nova, porque isso interromperia uma operação já aberta pelo endereço antigo. O retorno ao início é o link visível.

O estado fica em `sessionStorage`, separado por operador:

- pedido: etapa, cliente, itens, desconto, observação e confirmação;
- PDV: itens avulsos e parcelas já montadas.

Se a aba ainda tem operação de outro operador, ela não é substituída nem aberta. A mensagem avisa isso.

## 4. Banco e licença

Homologação visual em `127.0.0.1:3097`, banco `C:\Users\cicer\AppData\Local\Temp\cds-mobpdv06-ui\mercadao.db`. O log registrou `BANCO DE TESTE EM USO`. Esse diretório não é o oficial. O servidor foi encerrado ao fim.

A licença desse banco respondeu `LICENCA_AUSENTE` (“Sistema não ativado.”). A tela inicial mostrou o bloqueio e não o contornou. Empresa, catálogo e gravação de pedido real ficaram BLOQUEADOS por essa licença. Não há licença válida em um banco comprovadamente exclusivo de testes. A etapa de homologar com licença válida foi interrompida por isso.

O endereço do celular no servidor em uso continua `http://192.168.0.11:3001/mobile-pedido/` e `http://192.168.0.11:3001/mobile-pdv/`. A entrada nova, nesse mesmo servidor, é `http://192.168.0.11:3001/mobile/`.

## 5. Testes

Automatizados, em sequência, com `node --test --test-concurrency=1`:

| Arquivo | Resultado |
| --- | --- |
| `tests/mobile-pdv/pdv-mobile-06.test.js` | 2 passaram |
| `tests/pdv/sprint-25-interacao-sequencial.test.js` | 4 passaram |
| `tests/mobile-pdv/pdv-mobile-02.test.js` | 14 passaram |

O teste da entrada confirma as três rotas, o bloqueio de licença ainda presente no middleware e a preservação do pedido e da parcela pendente sem descartar a operação de outro operador.

No navegador, viewport 390×844 e também 768 px:

1. `/mobile/` sem sessão foi para `/login?next=/mobile/`.
2. Um login chegou à entrada.
3. PEDIDO abriu `/mobile-pedido/` sem outro login.
4. Início voltou para `/mobile/`.
5. PDV abriu `/mobile-pdv/` com o mesmo operador.
6. Início voltou de novo.
7. A alternância repetida manteve a sessão.
8. Operador “Administrador” permaneceu. Empresa continuou “Empresa não selecionada” porque a licença bloqueou a lista.
9. Um carrinho de 2 itens e R$ 20,00 foi retomado no Pedido.
10. No PDV, o item Refrigerante e a parcela PIX de R$ 8,00 pendente foram retomados. O pendente não entrou como recebido.
11. Sem token, `/mobile/` voltou ao login.
12. `/mobile-pedido/` e `/mobile-pdv/` abriram direto.
13. A licença ausente apareceu na entrada e não liberou a API.
14. Nenhuma conexão usou o banco oficial.

Os botões mediram 326×88 px em 390 de largura e 656×88 px em 768, sem rolagem horizontal.

## 6. Pendências

- Homologação com licença válida: BLOQUEADO. Só o banco oficial tem a licença configurada, e ele não foi usado.
- Seleção de empresa e inclusão de produto pela busca: BLOQUEADO pela mesma licença.
- Emissão fiscal e Smart POS Itaú: fora desta sprint.
