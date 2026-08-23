# Auditoria visual — PDV Universal (05.13)

## Cadeia oficial

```
GET /pdv-universal  (static frontend/pdv-universal/index.html)
        ↓
HTML #pdvu-root
        ↓
CSS /pdv-universal/pdv-universal.css
        ↓
JS entry: pdv-universal.js → bindUi()
        ↓
GET /api/pdv-universal/contexto
        ↓
LOADING → ERROR | READY
```

## Rotas

| Rota | HTML | Auth na prática |
| --- | --- | --- |
| `/pdv` | `frontend/pdv/index.html` (legado) | static + rota `verificarToken` + licença `pdv` |
| `/pdv-universal` | `frontend/pdv-universal/index.html` | static entrega o HTML; APIs exigem token |
| ERP → PDV Universal | `href="/pdv-universal"` | menu 05.12 |
| ERP → PDV legado | `href="/pdv"` | mantido |
| Dashboard PDV | `urlPdvUniversalOficial()` | 05.12 |

## HTML / CSS / JS

**Encontrados e conectados:** root, modo, empresa, busca, carrinho, FINALIZAR, modal empresa, modal item, pagamento, comprovante, loading/error/retry.

**Já existia mas estava desconectado ou pouco visível:**

1. `core.js` + jQuery no meio do HTML — risco de limpar overlays e puxar shell ERP. **Removido.**
2. Botão FINALIZAR sempre cinza no CSS mesmo habilitado. **Corrigido.**
3. Painel EMPRESAS NO ATENDIMENTO estático. **Agora lista empresas dos itens.**
4. MATERIALIZAR / FISCALIZAR / COMPROVANTE só no modal de pagamento. Fechar o modal escondia o fluxo. **Espelho na área principal após PAGO.**
5. Escolha multiempresa sem o título “ESTE PRODUTO POSSUI ESTOQUE EM”. **Corrigido.**

**Não existia (e não foi inventado motor):** nada de checkout/pagamento/MUV novo.

## APIs da tela

- GET `/api/pdv-universal/contexto`
- PUT `/api/pdv-universal/contexto/empresa`
- GET `/api/produtos/consulta-pdv/buscar`
- GET `/api/pdv-universal/produtos/:id/disponibilidade`
- POST `/api/pdv-universal/checkout`
- POST `.../reservar|pagamento|cancelar|materializar|fiscalizar`
- GET `.../comprovante`

## Itens que já existiam e estavam acessíveis

Carrinho `produto_id+empresa_id`, checkout isolado, locks 05.10, comprovante por `atendimento_id`.
