# AUDITORIA — BUSCA E IDENTIFICAÇÃO PDV (05.21)

**Sprint:** 05.21  
**Escopo:** mapear contratos reais antes de integrar no PDV Universal.  
**Proibido nesta auditoria:** copiar `pdv.js`, alterar MUV/VAS/`POST /api/vendas`.

---

## 1. Endpoint atual de busca do Universal

| Item | Valor confirmado |
|------|------------------|
| URL | `GET /api/produtos/consulta-pdv/buscar?q=` |
| Uso atual | `pdv-universal.js` → `urlBuscaProduto` / `buscarProdutos` |
| Backend | `backend/rotas/produtos.js` → `SearchService` (MIB) |
| Resposta | Array de produtos normalizados (máx. 20) |
| Aceita | nome parcial, código (texto livre via MIB) |

**STATUS:** ATIVO no Universal (autocomplete / digitação).

---

## 2. Endpoint `/produtos/identificar` (MIP)

| Item | Valor confirmado |
|------|------------------|
| URL | `POST /api/produtos/identificar` e `GET /api/produtos/identificar?codigo=` |
| Body POST | `{ codigo: string, contexto?: object }` |
| Serviço | `ProdutoIdentidadeService.resolve` via `obterPdvIdentificacaoService()` |
| Saldos | `aplicarSaldosIdentificacaoPdv` com `req.empresaId` (header contexto) |

### Formato de saída (IdentidadeResultadoDTO)

```json
{
  "encontrado": true,
  "habilitado": true,
  "produtoId": 123,
  "produto": { "id": 123, "nome": "...", "preco_venda": 1.5, "codigo": "...", "codigo_barras": "...", "plu": "..." },
  "metodo": "...",
  "strategy": "INTERNO|PLU|EAN13|EAN8|GTIN|ETIQUETA_BALANCA|ID",
  "meta": { "plu": "...", "peso": 0.5, "...": "..." },
  "confianca": "ALTA",
  "codigoOriginal": "789..."
}
```

Se flag MIP off: `{ encontrado: false, habilitado: false }` — cliente deve cair na busca textual.

**STATUS:** ATIVO (contrato oficial reutilizável). Universal **ainda não consumia** antes desta sprint.

---

## 3. Tipos de entrada (DetectorTipoCodigo — backend)

A decisão de tipo **não** deve ser reimplementada no frontend. O MIP classifica:

| Tipo | Critério (backend) | Strategy |
|------|--------------------|----------|
| Etiqueta balança | `^2` + 12 dígitos (13 total) | `ETIQUETA_BALANCA` |
| GTIN | 14 dígitos | `GTIN` |
| EAN-13 | 13 dígitos (não prefixo 2) | `EAN13` |
| EAN-8 | 8 dígitos | `EAN8` |
| Código interno | sempre candidato | `INTERNO` (`produtos.codigo`) |
| PLU | 1–6 dígitos | `PLU` (`produtos.plu`) |
| ID | 1–9 dígitos (sem zero à esquerda) | `ID` |

**STATUS:** ATIVO no backend. Frontend Universal deve **enviar o bruto** e consumir o DTO.

---

## 4. Código interno / barras / PLU

| Identificador | Campo cadastro | Contrato |
|---------------|----------------|----------|
| Código interno | `produtos.codigo` | MIP `INTERNO` |
| Código de barras | `produtos.codigo_barras` | MIP EAN/GTIN |
| PLU | `produtos.plu` | MIP `PLU` |
| Nome | — | `consulta-pdv` (MIB) |

Não inventar endpoint paralelo de PLU.

---

## 5. Etiqueta e Motor Equipamentos

| Camada | Contrato | STATUS |
|--------|----------|--------|
| MIP `ETIQUETA_BALANCA` | Resolve PLU + meta peso/valor no identificar | **ATIVO** |
| `POST /api/equipamentos/etiquetas/interpretar` | Usado pelo **legado** (`pdv.js`) antes/paralelo ao MIP | **ATIVO MAS LEGADO** (UI) |
| Layouts Toledo etc. | Backend equipamentos + MIP config | **ATIVO** |

**Universal 05.21:** usar só `identificar` (MIP).  
Não portar o fluxo jQuery de `interpretarEtiquetaViaMotorEquipamentos` do `pdv.js`.  
Quantidade = peso da etiqueta: **A MIGRAR** (nesta sprint qty=1; meta documentada, não aplicada como fonte de verdade sem sprint de peso).

---

## 6. Produtos com peso (auditoria §7)

| Aspecto | Onde | STATUS 05.21 |
|---------|------|--------------|
| `vendido_por_peso` / `produto_fracionado` | cadastro / legado | **A MIGRAR** (UI Universal) |
| `peso_medio_unidade` | legado `pdv.js` | **A MIGRAR** |
| Peso em `meta` do MIP (etiqueta) | backend MIP | **ATIVO** (contrato); uso qty no Universal = **A MIGRAR** |
| Balança contínua / F7 peso | — | **NÃO UTILIZADO** / **SEM CONTRATO** de atalho (F7 legado = caixa) |
| Motor Equipamentos drivers | backend | **ATIVO** (infra); sem binding Universal |

---

## 7. Disponibilidade multiempresa

| Modo | Fluxo oficial Universal |
|------|-------------------------|
| EMPRESA_UNICA | `empresa_selecionada` → item com essa `empresa_id` |
| MULTIEMPRESA | `GET /api/pdv-universal/produtos/:id/disponibilidade` → escolha se várias |

Identificar **não** deve fixar `empresa_id = 1`.  
Saldos no DTO do identificar usam `req.empresaId` (header); a adição ao carrinho continua passando por `identificarEmpresaOperacional` + disponibilidade Universal.

---

## 8. O que o legado faz e NÃO será copiado

| Item legado | Decisão |
|-------------|--------|
| `pdv.js` monolito / jQuery handlers | **NÃO COPIAR** |
| Cache `produtosDisponiveis` local | **NÃO COPIAR** |
| `interpretarCodigoBalanca` local | **NÃO COPIAR** (MIP cobre) |
| `POST /api/equipamentos/etiquetas/interpretar` no Enter | **NÃO nesta sprint** |
| Modal F1 consulta completa | **NÃO** (F1 = foco) |
| Cálculo peso×preço no front | **NÃO** |
| `POST /api/vendas` após identificar | **PROIBIDO** |

---

## 9. Fluxo alvo Universal (05.21)

```
INPUT (busca / leitor + ENTER)
  → identificarEntradaPdv (adaptador Universal)
      → POST /produtos/identificar   (se único → produto)
      → senão GET consulta-pdv/buscar
  → UNICO → disponibilidade + carrinho oficial + qty 1
  → MULTIPLOS → lista; ENTER confirma seleção
  → NAO_ENCONTRADO → aviso; foco permanece
  → checkout continua POST /api/pdv-universal/checkout
```

---

## 10. Contratos a utilizar na implementação

1. `POST /api/produtos/identificar`  
2. `GET /api/produtos/consulta-pdv/buscar`  
3. `GET /api/pdv-universal/produtos/:id/disponibilidade`  
4. Carrinho `PDVUniversalCart`  
5. Checkout `POST /api/pdv-universal/checkout` (intacto)
