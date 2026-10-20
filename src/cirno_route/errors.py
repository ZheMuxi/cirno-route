class ClassifierError(Exception):
    """A fixed public error code; never includes raw task or backend response text."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)
