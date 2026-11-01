# MOBILE-PEDIDO-01 — Auditoria do estado atual

Auditoria somente de leitura do código. Nenhum aplicativo, tela, banco, container ou ambiente novo foi criado. O banco oficial `C:\ProgramData\MercantilFiscal\dados\mercadao.db` não foi aberto. Nenhuma venda, NFC-e, TEF ou transmissão à SEFAZ foi executada.

Conclusão: não existe um aplicativo Mobile Pedido no repositório. O caminho mais curto é uma casca de telas sobre o que o ERP já grava em `POST /api/pedidos`, sem um segundo núcleo de pedido.

## 1. Arquitetura encontrada

| Item | Estado |
|---|---|
| Repositório | `C:\projetos\CDS-SISTEMAS PASTELARIA` |
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| Pacote | `cds-sistemas` 1.0.3 |
| Runtime | Node.js 24.19.0 |
| Desktop | Electron 22.3.27 |
| API | Express 4.18.2 |
| Banco | SQLite, driver npm `sqlite3` 5.1.6. O processo do CDS usa `DB_DIR` ou, na ausência dele, `C:\ProgramData\MercantilFiscal\dados\mercadao.db` |
| Frontend | HTML, JavaScript, jQuery e Bootstrap. Não há React, Vue, React Native, Capacitor nem manifesto PWA |
| Mobile Pedido | Ausente. Não há diretório, rota, tela nem símbolo `PedidoLoader` |

O pedido que existe hoje é a página ERP `pedidos`, carregada por `frontend/erp/js/app.js` a partir de `frontend/erp/js/pedidos.js`. Ela entra pelo menu Retaguarda (`data-page="pedidos"`), exige o recurso de implantação `pedidos` e o cabeçalho `X-Empresa-Id`.

A gravação passa por uma única porta:

1. `POST /api/pedidos` em `backend/rotas/pedidos.js`, com token e recurso `pedidos`.
2. `EntradaPedidoService.receber`, que fixa o canal no servidor. O corpo da requisição não escolhe o canal.
3. `PedidoOperacionalService.criar`, que valida itens, total, mesa, personalização e estoque.
4. `PedidoRepository` persiste `pedidos` e `pedidos_itens`.

Canais declarados em `EntradaPedidoService`: `EQUIPE`, `BALCAO`, `MESA`, `CARDAPIO_WEB`. Só `EQUIPE` está habilitado. `POST /api/pedidos` chama sempre `EQUIPE`. `CARDAPIO_WEB` responde `CANAL_ORIGEM_NAO_HABILITADO`.

`PedidoLoader` não existe. O componente visual `CDSLoader` do design system não carrega pedido.

## 2. Funcionalidades já existentes

A classificação abaixo é do fluxo operacional de pedido. Onde a função existe só na página ERP de desktop, isso está dito na observação. Não há telas mobile.

| Funcionalidade | Classificação | Onde está |
|---|---|---|
| Telas mobile | NÃO IMPLEMENTADA | Nenhuma rota ou página própria |
| Navegação mobile | NÃO IMPLEMENTADA | A página ERP é uma lista mais um modal `modal-xl` |
| Autenticação e sessão | CONCLUÍDA | `POST /api/auth/login`. O token fica em `localStorage` (`token`). O login apaga `cds_empresa_id` da sessão anterior |
| Seleção de empresa | CONCLUÍDA no ERP | `CdsEmpresaContexto` grava a empresa e envia `X-Empresa-Id`. A lista e o editor recusam abrir sem empresa |
| Seleção de cliente | CONCLUÍDA no ERP | `GET /api/clientes/buscar`. Cliente é opcional. O cabeçalho aceita `cliente_id` nulo |
| Catálogo e pesquisa | CONCLUÍDA no ERP | `GET /api/produtos/consulta-pdv/buscar` e, ao escolher, `GET /api/produtos/:id` |
| Preços e condições | PARCIAL | A sugestão usa `preco_pedido`; se estiver nulo, promoção ou `preco_venda`. O operador pode alterar o valor na grade, exceto item personalizado. O backend confere o total (`PEDIDO_TOTAL_INCONSISTENTE`) e a origem do snapshot (`PRECO_PEDIDO`, `PROMOCAO`, `PRECO_VENDA`). Não há tabela de condição comercial por cliente neste fluxo |
| Carrinho e quantidades | CONCLUÍDA no ERP | Lista em memória `itensEditor`, com quantidade, desconto percentual, exclusão e edição |
| Observações dos itens | PARCIAL | Existe observação do pedido (`observacao`). Item personalizado guarda ingredientes da ficha técnica. Não há texto livre por item |
| Cálculo do total | CONCLUÍDA no ERP, conferido no servidor | Subtotal dos itens, desconto em reais, frete e total. O servidor recalcula e recusa divergência acima de R$ 0,01 |
| Salvamento | CONCLUÍDA no ERP | `POST /api/pedidos` com `Idempotency-Key`. Edição usa `PUT /api/pedidos/:id` |
| Recuperação | PARCIAL | Pedido já gravado volta por `GET /api/pedidos` e `GET /api/pedidos/:id`. O carrinho em edição não é salvo localmente: fechar o modal perde o rascunho |
| Envio ao backend | CONCLUÍDA no ERP | O payload leva cliente, mesa, observação, frete, desconto, total, status `PEDIDO` e os snapshots de preço |
| Erros e carregamento | PARCIAL | Lista e mesas mostram “Carregando…”. Falha de gravação aparece em alerta. A pesquisa de cliente e produto engole o erro e só fecha a sugestão. Não há estado de carregamento no botão Salvar |
| Mesas | CONCLUÍDA no ERP | Cadastro e vínculo por empresa em `/api/mesas`, mesa opcional no pedido |
| Personalização de ingredientes | CONCLUÍDA no ERP | Modal próprio, preço-base somente leitura, adicionais recalculados |
| Impressão | CONCLUÍDA no ERP | Cupom térmico pelo Electron e visualização A4 |
| Confirmação após gravar | PARCIAL | Alerta com o código do pedido e retorno à lista. Em seguida a tela pergunta se deve gerar venda no PDV |

## 3. Funcionalidades pendentes

- Aplicativo ou conjunto de telas mobile: login já pode ser reutilizado, mas não há destino mobile depois do login.
- Passos separados Cliente, Produtos, Carrinho, Conferência e Confirmação. Hoje isso é um único modal de desktop, com atalhos F2, Ctrl+S, Ctrl+F, setas e Delete.
- Rascunho local do carrinho.
- Observação livre por item.
- Canal `CARDAPIO_WEB` (e `BALCAO`) com adaptador. Hoje estão no contrato e recusados.
- Confirmação que permaneça no pedido. O passo seguinte oferecido é abrir o PDV (`/pdv`) para gerar venda.
- `PedidoLoader`. Não deve ser criado como segundo núcleo. A porta já é `EntradaPedidoService`.

## 4. APIs e serviços reutilizáveis

O aplicativo deve chamar estes contratos e deixar a validação no servidor.

| Uso | Contrato |
|---|---|
| Login | `POST /api/auth/login` |
| Empresa | `CdsEmpresaContexto` e cabeçalho `X-Empresa-Id`. Sem empresa, `empresaIdDoReqPedido` fica nulo e a entrada responde `EMPRESA_CONTEXT_REQUIRED` |
| Clientes | `GET /api/clientes/buscar?termo=` |
| Catálogo | `GET /api/produtos/consulta-pdv/buscar?q=&limite=15`, depois `GET /api/produtos/:id` |
| Ficha, se o produto personaliza | `GET /api/produtos/:id/ficha-tecnica` |
| Gravar | `POST /api/pedidos` com `Idempotency-Key`. Canal fixo `EQUIPE` |
| Reler | `GET /api/pedidos/:id` e `GET /api/pedidos` |
| Alterar pedido ainda editável | `PUT /api/pedidos/:id` |
| Mesa, se a operação usar | rotas de mesas já usadas pela página ERP |
| Estoque e reserva | `PedidoConsumoEstoqueService` via `PedidoOperacionalService` e Motor Comercial. A tela não reserva estoque por conta própria |
| Total | O cliente pode exibir a soma. Quem aceita é `montarCabecalho` |

Preço sugerido na página atual, para não duplicar a regra na casca:

- se `preco_pedido` estiver preenchido, ele é o valor inicial e a origem é `PRECO_PEDIDO`;
- senão, `preco_promocional` com origem `PROMOCAO`, ou `preco_venda` com origem `PRECO_VENDA`.

O nome exibido na busca é `nome_comercial`, com fallback para o nome principal. O XML fiscal continua no nome principal; esta auditoria não altera isso.

## 5. Problemas encontrados

1. Não há Mobile Pedido. Procurar `PedidoLoader`, `mobile-pedido` ou um frontend mobile não retorna módulo.
2. A página que grava pedido é de desktop: modal largo, tabela e teclado. O `viewport` do ERP existe, a navegação do pedido não foi feita para telefone.
3. Depois de salvar, a interface oferece gerar venda no PDV. Esse passo sai do pedido e não é a confirmação mobile.
4. O carrinho só existe na memória da página.
5. Observação é do pedido inteiro. Item não tem texto livre.
6. Pesquisa de cliente ou produto com falha de rede não mostra erro.
7. Três testes já existentes do núcleo falharam nesta leitura. Nenhum foi corrigido, porque esta sprint não altera código:
   - `entrada-pedido-central`: o pedido foi criado no canal `EQUIPE`, com uma reserva, e o saldo fiscal permaneceu 200 quando o teste esperava 197. A baixa de estoque desse cenário não ocorreu.
   - `mesas-pedido-operacional`: criar o pedido da mesa falhou com `UNIDADE_ESTOQUE_INVALIDA` (“Não foi possível determinar as unidades comercial e de estoque do produto Pastel MESA”). Produto sem unidade que o conversor reconhece não entra no pedido.
   - `pedido-operacional-sprint-b1`: o caso do total 99,99 contra itens de 43,98 não chegou em `PEDIDO_TOTAL_INCONSISTENTE`. `prepararItens` disparou `SQLITE_ERROR: duplicate column name: utiliza_ficha_tecnica` enquanto o banco temporário ainda aplicava o mesmo `ALTER TABLE`. Os outros dois casos do arquivo, que usam banco em memória já preparado, passaram.
8. `nome-comercial-preco-pedido-http` executou a criação, a leitura, a alteração e a busca de `nome_comercial` e `preco_pedido`. O arquivo falhou no fim porque `produtos.js` grava o campo com `data.nome_comercial = ($('#nome_comercial').val() || '').trim() || null`, e o teste ainda procura o formato antigo `nome_comercial: ($('#nome_comercial').val()`. A proteção do XML fiscal desse arquivo não chegou a ser executada.

## 6. Evidências dos testes

Execução sequencial, `node --test --test-concurrency=1`, em 2026-11-01. Arquivos que carregam `backend/database.js` receberam um `DB_DIR` temporário novo em `%TEMP%\cds-mobped-*`, com `CDS_TEST_ISOLATION=1` e `CDS_BLOQUEAR_BANCO_OFICIAL=1`. O banco oficial não entrou nesses processos.

| Arquivo | Resultado |
|---|---|
| `tests/faturamento/sprint35-pedidos-ui.test.js` | 5 passaram |
| `tests/faturamento/sprint36-pedidos-ux.test.js` | 7 passaram |
| `tests/pedidos/pedido-impressao-termica.test.js` | 3 passaram |
| `tests/pedidos/tela-pedidos-operacional-adaptada.test.js` | 8 passaram |
| `tests/pedidos/entrada-pedido-central.test.js` | 8 passaram, 1 falhou (saldo 200, esperado 197) |
| `tests/pedidos/mesas-pedido-operacional.test.js` | 12 passaram, 1 falhou (`UNIDADE_ESTOQUE_INVALIDA`) |
| `tests/pedidos/pedido-operacional-sprint-b1.test.js` | 2 passaram, 1 falhou (coluna `utiliza_ficha_tecnica` duplicada no banco ainda em migração) |
| `tests/pedidos/pedido-encerrado-imutabilidade.test.js` | 5 passaram |
| `tests/pedidos/preco-pedido-nome-comercial.test.js` | 8 passaram |
| `tests/produtos/nome-comercial-preco-pedido-http.test.js` | a API de nome comercial e preço do pedido respondeu; o arquivo falhou na asserção de fonte da tela de produto |

O contrato de canal passou: só `EQUIPE` é aceito; canal inválido, canal desabilitado e empresa ausente não criam pedido.

## 7. Proposta de sequência

1. Casca mobile no frontend já servido pelo CDS, sem projeto, banco ou API novos.
2. Reusar login, seletor de empresa e os quatro contratos da tabela acima.
3. Quatro telas finas: cliente, produtos, carrinho com conferência, confirmação com o código devolvido por `POST /api/pedidos`.
4. Montar o mesmo payload que `salvarPedido` já envia, inclusive snapshots e `Idempotency-Key`. O total exibido tem de ser o total que o servidor recalcula.
5. Tratar `EMPRESA_CONTEXT_REQUIRED`, `PEDIDO_TOTAL_INCONSISTENTE`, `UNIDADE_ESTOQUE_INVALIDA` e `MODULO_NAO_LICENCIADO` com mensagem na tela.
6. Deixar a geração de venda no PDV fora dessa casca.
7. Só depois, se o canal de cardápio for necessário, habilitar um adaptador servidor para `CARDAPIO_WEB`. O cliente continua sem escolher o canal.

## 8. Menor próxima sprint

**MOBILE-PEDIDO-02 — casca do pedido da equipe.**

Uma página mobile, no mesmo frontend, com o fluxo Cliente → Produtos → Carrinho/Conferência → Gravação → código do pedido. Ela usa `POST /api/pedidos` no canal `EQUIPE`, com a empresa já selecionada. Não cria `PedidoLoader`, não abre o PDV, não habilita `CARDAPIO_WEB` e não duplica preço, estoque ou total.

Fora dessa sprint: corrigir a baixa de estoque do teste central, a unidade do cenário de mesa e a coluna duplicada de ficha técnica. São falhas do núcleo já medidas aqui; misturá-las com a casca aumenta o escopo.

## Fluxo operacional

```text
Login (existe)
  → Empresa (existe no seletor do ERP)
    → Cliente (existe dentro do modal)
      → Produtos (existe dentro do modal)
        → Carrinho (memória da página)
          → Conferência (o mesmo modal, sem tela própria)
            → Gravação POST /api/pedidos (existe)
              → Confirmação (alerta + lista; o passo seguinte oferecido é o PDV)
```

O fluxo interrompe antes de existir como aplicativo: não há entrada mobile. Dentro do ERP, o pedido é gravado e confirmado na lista. A limitação seguinte é o desvio para o PDV e a ausência de rascunho, de observação por item e de telas separadas.

Esta auditoria não homologa o Mobile Pedido. Ele ainda não está implementado.
