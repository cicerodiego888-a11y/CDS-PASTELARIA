# EVIDÊNCIA — Origem autenticada da unidade operacional

## Cadeia (pós última correção)

```
Login (body.unidade_cozinha_id + empresa_id opcional)
    → validarUnidadeCozinhaNoLogin({ db, usuario, unidade, empresa })
         ├─ cozinha_unidades: existe + ativo
         ├─ empresa da unidade vs sessão
         ├─ usuario_empresas: operador na empresa
         └─ cozinha_operador_unidades: vínculo (não-admin)
    → rejeita: UNIDADE_INEXISTENTE | UNIDADE_INATIVA
               | UNIDADE_EMPRESA_ISOLAMENTO | UNIDADE_NAO_AUTORIZADA
    → jwt.sign({ ..., unidade_cozinha_id: <unidade VALIDADA> })
    → Cliente envia Authorization: Bearer <token>
    → verificarToken → req.user = payload JWT
    → resolverUnidadeOperacionalReq(req)
         └─ lê req.user.unidade_cozinha_id
         └─ se body/query.unidade_id presente: deve ser igual à sessão
    → CozinhaPreparacao.*(…, unidade_id: <sessão>)
         └─ exigirUnidadeOperacional + item.unidade_id
```

## Por que isso é autenticado

1. **No login:** o claim só entra no JWT depois da validação no cadastro. O body sozinho não basta.
2. **Na sessão:** o valor efetivo das ops vem do JWT assinado com `JWT_SECRET`.
3. **No request:** body/query só confirmam a unidade da sessão; nunca a substituem.
4. **Reemissão de token:** passa de novo por `validarUnidadeCozinhaNoLogin` — não contorna autorização.

## Códigos

| Entrada | Resultado |
|---|---|
| Login sem `unidade_cozinha_id` | OK (PDV); JWT sem claim de unidade |
| Login unidade autorizada | JWT com claim validado |
| Login unidade sem vínculo | `UNIDADE_NAO_AUTORIZADA` (403) |
| Login unidade outra empresa | `UNIDADE_EMPRESA_ISOLAMENTO` / `UNIDADE_NAO_AUTORIZADA` |
| Login unidade inexistente | `UNIDADE_INEXISTENTE` |
| Login unidade inativa | `UNIDADE_INATIVA` |
| JWT sem `unidade_cozinha_id` nas ops | `UNIDADE_OBRIGATORIA` |
| JWT com unidade; body omitido | usa sessão |
| JWT com unidade; body igual | ok |
| JWT com unidade; body outra | `UNIDADE_ISOLAMENTO` |
| Sessão ≠ item.unidade_id | `UNIDADE_ISOLAMENTO` |
| Token inválido / middleware | 401 |

## Evidência de testes

`tests/cozinha/sprint05-login-unidade-auth.test.js` — 7/7 (inclui HTTP real nas 3 ops).  
Log: `LOG-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.txt`.
