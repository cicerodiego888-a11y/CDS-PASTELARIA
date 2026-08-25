# IMPLEMENTAÇÃO 05.21 — BUSCA OPERACIONAL E IDENTIFICAÇÃO

**Confirmação explícita:**

> Identificação e adição de produtos foram integradas ao pipeline oficial do PDV Universal.

PDV Universal permanece o único alvo arquitetural.  
PDV legado permanece temporariamente por compatibilidade.

---

## 1. Arquivos

| Arquivo | Papel |
|---------|--------|
| `docs/arquitetura/AUDITORIA_BUSCA_IDENTIFICACAO_PDV_05_21.md` | Auditoria prévia |
| `frontend/pdv-universal/pdv-universal-identificacao.js` | Adaptador `identificarEntradaPdv` |
| `frontend/pdv-universal/pdv-universal.js` | ENTER/BUSCAR → identificar → carrinho; foco |
| `frontend/pdv-universal/index.html` | Script do adaptador |
| `frontend/pdv-universal/pdv-universal.css` | Destaque resultado selecionado |
| `tests/pdv-universal/busca-identificacao-05-21.test.js` | Aceite |
| `tests/pdv-universal/fundacao-visual-05-20.test.js` | Ajuste nome busca |
| `tests/pdv-universal/ativacao-visual-acesso-05-12.test.js` | Asset novo na lista |
| `docs/arquitetura/IMPLEMENTACAO_05_21_RELATORIO.md` | Este relatório |

**Não alterados:** MUV, VAS, `POST /api/vendas`, `pdv.js`, motor fiscal, rota `/pdv`, checkout backend.

---

## 2. Contratos realmente utilizados

1. `POST /api/produtos/identificar` — MIP (barras, interno, PLU, EAN, etiqueta no backend)
2. `GET /api/produtos/consulta-pdv/buscar` — autocomplete textual + fallback
3. `GET /api/pdv-universal/produtos/:id/disponibilidade` — empresa
4. `PDVUniversalCart` — carrinho oficial
5. `POST /api/pdv-universal/checkout` — intacto

---

## 3. Fluxo implementado

```
INPUT / ENTER / BUSCAR
  → identificarEntradaPdv
      → POST /produtos/identificar
      → se não único → consulta-pdv
  → UNICO → disponibilidade → carrinho (qty=1) → limpa input → foco
  → MULTIPLOS → lista + ↑↓; 2º ENTER confirma
  → NAO_ENCONTRADO → aviso; foco permanece
```

Digitação (debounce): só `consulta-pdv` (não martela identificar).

---

## 4. Encontrado no legado e NÃO copiado

- `pdv.js` / jQuery handlers  
- `interpretarEtiquetaViaMotorEquipamentos`  
- `interpretarCodigoBalanca` local  
- cache `produtosDisponiveis`  
- modal F1 consulta completa  
- qty = peso da etiqueta no front  
- `POST /api/vendas`  

---

## 5. Quantidade / peso

| Item | STATUS |
|------|--------|
| qty padrão = 1 | **ATIVO** |
| `+/-` no carrinho Universal | **ATIVO** (já existia) |
| peso etiqueta → qty | **A MIGRAR** |
| `vendido_por_peso` / peso médio | **A MIGRAR** |
| F7 = peso | **NÃO UTILIZADO** (proibido) |
| MIP etiqueta strategy | **ATIVO** (backend); qty no Universal ainda 1 |

---

## 6. Atalhos

| Atalho | Comportamento |
|--------|----------------|
| F1 | Foco busca |
| ENTER | Identificar / confirmar seleção |
| ↑↓ | Navegar resultados |

Não: F4, F7, F8, F9, F11, F12.

---

## 7. Testes

| Suite | Resultado |
|-------|-----------|
| `busca-identificacao-05-21` | **18/18** |
| `fundacao-visual-05-20` | 18/18 |
| `ativacao-visual-acesso-05-12` | 19/19 |
| `tela-principal-05-03` | 15/15 |
| `carrinho-universal-05-04` | 25/25 |
| `auditoria-visual-correcao-05-13` | 29/29 |
| `estabilizacao-operacional-05-10` | 20/20 |
| `checkout-empresa-unica-05-05` | 18/18 |
| `checkout-multiempresa-05-06` | 25/25 |
| `pagamento-unificado-muv-05-07` | 25/25 |
| `materializacao-fiscal-comprovante-05-08` | 19/19 |

---

## 8. Critério de aceite

Operador em `/pdv-universal/`: digita ou lê código → ENTER → produto no atendimento oficial → foco volta → próximo item. Sem `pdv.js`, sem `POST /api/vendas`.
