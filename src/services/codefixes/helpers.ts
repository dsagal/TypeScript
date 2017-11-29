/* @internal */
namespace ts.codefix {
    /**
     * Finds members of the resolved type that are missing in the class pointed to by class decl
     * and generates source code for the missing members.
     * @param possiblyMissingSymbols The collection of symbols to filter and then get insertions for.
     * @returns Empty string iff there are no member insertions.
     */
    //use changetracker!
    export function createMissingMemberNodes(classDeclaration: ClassLikeDeclaration, possiblyMissingSymbols: ReadonlyArray<Symbol>, checker: TypeChecker, out: (node: Node) => void): void {
        const classMembers = classDeclaration.symbol.members;
        for (const symbol of possiblyMissingSymbols) {
            if (!classMembers.has(symbol.escapedName)) {
                addNewNodeForMemberSymbol(symbol, classDeclaration, checker, out);
            }
        }
    }

    /**
     * @returns Empty string iff there we can't figure out a representation for `symbol` in `enclosingDeclaration`.
     */
    function addNewNodeForMemberSymbol(symbol: Symbol, enclosingDeclaration: ClassLikeDeclaration, checker: TypeChecker, out: (node: Node) => void): void {
        const declarations = symbol.getDeclarations();
        if (!(declarations && declarations.length)) {
            return undefined;
        }

        const declaration = declarations[0] as Declaration;
        // Clone name to remove leading trivia.
        const name = getSynthesizedClone(getNameOfDeclaration(declaration)) as PropertyName;
        const visibilityModifier = createVisibilityModifier(getModifierFlags(declaration));
        const modifiers = visibilityModifier ? createNodeArray([visibilityModifier]) : undefined;
        const type = checker.getWidenedType(checker.getTypeOfSymbolAtLocation(symbol, enclosingDeclaration));
        const optional = !!(symbol.flags & SymbolFlags.Optional);

        switch (declaration.kind) {
            case SyntaxKind.GetAccessor:
            case SyntaxKind.SetAccessor:
            case SyntaxKind.PropertySignature:
            case SyntaxKind.PropertyDeclaration:
                const typeNode = checker.typeToTypeNode(type, enclosingDeclaration);
                out(createProperty(
                    /*decorators*/undefined,
                    modifiers,
                    name,
                    optional ? createToken(SyntaxKind.QuestionToken) : undefined,
                    typeNode,
                    /*initializer*/ undefined));
                break;
            case SyntaxKind.MethodSignature:
            case SyntaxKind.MethodDeclaration:
                // The signature for the implementation appears as an entry in `signatures` iff
                // there is only one signature.
                // If there are overloads and an implementation signature, it appears as an
                // extra declaration that isn't a signature for `type`.
                // If there is more than one overload but no implementation signature
                // (eg: an abstract method or interface declaration), there is a 1-1
                // correspondence of declarations and signatures.
                const signatures = checker.getSignaturesOfType(type, SignatureKind.Call);
                if (!some(signatures)) {
                    break;
                }

                if (declarations.length === 1) {
                    Debug.assert(signatures.length === 1);
                    const signature = signatures[0];
                    signatureToMethodDeclaration(signature, enclosingDeclaration, createStubbedMethodBody());
                    break;
                }

                for (const signature of signatures) {
                    signatureToMethodDeclaration(signature, enclosingDeclaration);
                }

                if (declarations.length > signatures.length) {
                    const signature = checker.getSignatureFromDeclaration(declarations[declarations.length - 1] as SignatureDeclaration);
                    signatureToMethodDeclaration(signature, enclosingDeclaration, createStubbedMethodBody());
                }
                else {
                    Debug.assert(declarations.length === signatures.length);
                    out(createMethodImplementingSignatures(signatures, name, optional, modifiers));
                }
                break;
        }

        function signatureToMethodDeclaration(signature: Signature, enclosingDeclaration: Node, body?: Block) {
            const signatureDeclaration = <MethodDeclaration>checker.signatureToSignatureDeclaration(signature, SyntaxKind.MethodDeclaration, enclosingDeclaration, NodeBuilderFlags.SuppressAnyReturnType);
            if (!signatureDeclaration) {
                return;
            }

            signatureDeclaration.decorators = undefined;
            signatureDeclaration.modifiers = modifiers;
            signatureDeclaration.name = name;
            signatureDeclaration.questionToken = optional ? createToken(SyntaxKind.QuestionToken) : undefined;
            signatureDeclaration.body = body;
            out(signatureDeclaration);
        }
    }

    export function createMethodFromCallExpression(callExpression: CallExpression, methodName: string, inJs: boolean, makeStatic: boolean): MethodDeclaration {
        return createMethod(
            /*decorators*/ undefined,
            /*modifiers*/ makeStatic ? [createToken(SyntaxKind.StaticKeyword)] : undefined,
            /*asteriskToken*/ undefined,
            methodName,
            /*questionToken*/ undefined,
            /*typeParameters*/ inJs ? undefined : callExpression.typeArguments && callExpression.typeArguments.map((_, i) =>
                createTypeParameterDeclaration(callExpression.typeArguments.length <= CharacterCodes.Z - CharacterCodes.T ? String.fromCharCode(CharacterCodes.T + i) : `T${i}`)),
            /*parameters*/ createDummyParameters(callExpression.arguments.length, /*names*/ undefined, /*minArgumentCount*/ undefined, inJs),
            /*type*/ inJs ? undefined : createKeywordTypeNode(SyntaxKind.AnyKeyword),
            createStubbedMethodBody());
    }

    function createDummyParameters(argCount: number,  names: string[] | undefined, minArgumentCount: number | undefined, inJs: boolean): ParameterDeclaration[] {
        const parameters: ParameterDeclaration[] = [];
        for (let i = 0; i < argCount; i++) {
            const newParameter = createParameter(
                /*decorators*/ undefined,
                /*modifiers*/ undefined,
                /*dotDotDotToken*/ undefined,
                /*name*/ names && names[i] || `arg${i}`,
                /*questionToken*/ minArgumentCount !== undefined && i >= minArgumentCount ? createToken(SyntaxKind.QuestionToken) : undefined,
                /*type*/ inJs ? undefined : createKeywordTypeNode(SyntaxKind.AnyKeyword),
                /*initializer*/ undefined);
            parameters.push(newParameter);
        }
        return parameters;
    }

    function createMethodImplementingSignatures(signatures: ReadonlyArray<Signature>, name: PropertyName, optional: boolean, modifiers: ReadonlyArray<Modifier> | undefined): MethodDeclaration {
        /** This is *a* signature with the maximal number of arguments,
         * such that if there is a "maximal" signature without rest arguments,
         * this is one of them.
         */
        let maxArgsSignature = signatures[0];
        let minArgumentCount = signatures[0].minArgumentCount;
        let someSigHasRestParameter = false;
        for (const sig of signatures) {
            minArgumentCount = Math.min(sig.minArgumentCount, minArgumentCount);
            if (sig.hasRestParameter) {
                someSigHasRestParameter = true;
            }
            if (sig.parameters.length >= maxArgsSignature.parameters.length && (!sig.hasRestParameter || maxArgsSignature.hasRestParameter)) {
                maxArgsSignature = sig;
            }
        }
        const maxNonRestArgs = maxArgsSignature.parameters.length - (maxArgsSignature.hasRestParameter ? 1 : 0);
        const maxArgsParameterSymbolNames = maxArgsSignature.parameters.map(symbol => symbol.name);

        const parameters = createDummyParameters(maxNonRestArgs, maxArgsParameterSymbolNames, minArgumentCount, /*inJs*/ false);

        if (someSigHasRestParameter) {
            const anyArrayType = createArrayTypeNode(createKeywordTypeNode(SyntaxKind.AnyKeyword));
            const restParameter = createParameter(
                /*decorators*/ undefined,
                /*modifiers*/ undefined,
                createToken(SyntaxKind.DotDotDotToken),
                maxArgsParameterSymbolNames[maxNonRestArgs] || "rest",
                /*questionToken*/ maxNonRestArgs >= minArgumentCount ? createToken(SyntaxKind.QuestionToken) : undefined,
                anyArrayType,
                /*initializer*/ undefined);
            parameters.push(restParameter);
        }

        return createStubbedMethod(
            modifiers,
            name,
            optional,
            /*typeParameters*/ undefined,
            parameters,
            /*returnType*/ undefined);
    }

    function createStubbedMethod(
        modifiers: ReadonlyArray<Modifier>,
        name: PropertyName,
        optional: boolean,
        typeParameters: ReadonlyArray<TypeParameterDeclaration> | undefined,
        parameters: ReadonlyArray<ParameterDeclaration>,
        returnType: TypeNode | undefined) {
        return createMethod(
            /*decorators*/ undefined,
            modifiers,
            /*asteriskToken*/ undefined,
            name,
            optional ? createToken(SyntaxKind.QuestionToken) : undefined,
            typeParameters,
            parameters,
            returnType,
            createStubbedMethodBody());
    }

    function createStubbedMethodBody() {
        return createBlock(
            [createThrow(
                createNew(
                    createIdentifier("Error"),
                    /*typeArguments*/ undefined,
                    [createLiteral("Method not implemented.")]))],
            /*multiline*/ true);
    }

    function createVisibilityModifier(flags: ModifierFlags): Modifier | undefined {
        if (flags & ModifierFlags.Public) {
            return createToken(SyntaxKind.PublicKeyword);
        }
        else if (flags & ModifierFlags.Protected) {
            return createToken(SyntaxKind.ProtectedKeyword);
        }
        return undefined;
    }
}
