# Auditoria geral visual — Sprint 05.16

## Caminho real — Empresas

MENU Configurações → `data-page="configuracoes-avancadas"`  
→ `cds-centro-configuracoes.js` botão **Empresas** → `loadPage('empresas')`  
→ `app.js` carrega `/erp/js/gestao-empresas-fiscal.js?v=0516`  
→ `loadGestaoEmpresasFiscal()`  
→ `GET /api/empresas` + `GET /api/empresas/configuracao-fiscal/status`  
Não há HTML próprio: o conteúdo é injetado em `#page-content` do ERP.

Não existe item **Empresas** no menu lateral (Administração).

## Causas reais das abas “não existirem”

1. **ERP lazy cache** — o módulo `gestao-empresas-fiscal.js` era carregado uma vez e reutilizado. Sessão aberta antes da 05.15 ficava com JS antigo (só formulário de nova empresa).
2. **GET status derrubava a lista** — falha no status punha a tela em ERROR e `#gef-detalhe` sumia; `abrirDetalhe` não tinha onde pintar.
3. **Transição NOVA → EDIÇÃO frágil** — dependia só de `criada.id` e de `carregarLista()` ter sucesso antes. Sem id ou sem `#gef-detalhe`, o operador voltava ao formulário de criação.
4. **Estado vazio + Nova empresa** — o operador vê só dados gerais **enquanto a empresa ainda não existe**. Isso é correto. As abas só após POST com `id` oficial e painel `data-gef-edicao="1"`.

## Código morto / classificação

| FUNCIONALIDADE | ARQUIVO | ESTADO REAL | CAUSA | AÇÃO |
|---|---|---|---|---|
| Abas fiscal/cert | gestao-empresas-fiscal.js | C — existiam no JS, pouco acessíveis | cache lazy + detalhe destruído | CORRIGIDO |
| Criar empresa | POST /api/empresas | A se CNPJ válido | validação 04.01 | OK |
| Abrir edição após criar | salvarNovaEmpresa | C | id + remount | CORRIGIDO |
| /api/api | urlAbsoluta | A após 05.14 | — | OK |
| PDV menu | erp/index.html | A href `/pdv-universal/` | — | OK |
| GET contexto | pdv-universal.js | A se houver empresa | 409 se cadastro vazio | OK (não mascarar) |
| Checkout…comprovante | rotas + bindUi | A no código | não clicado nesta sessão | PENDENTE MANUAL |

## Rotas

Empresas: GET/POST `/api/empresas`, GET/PUT `/api/empresas/:id` (PUT exige contexto), GET/PUT/DELETE config fiscal, GET status, POST certificado com `empresa_id`.

PDV: GET contexto, PUT contexto/empresa, POST checkout, reservar, pagamento, cancelar, materializar, fiscalizar, GET comprovante. Todas atrás de `verificarToken`. Frontend envia Bearer.
